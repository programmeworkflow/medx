import type { VercelRequest, VercelResponse } from "@vercel/node";
import forge from "node-forge";
import { supaAdmin, encryptSecret, corsHeaders } from "./_lib.js";

export const config = {
  api: { bodyParser: { sizeLimit: "10mb" } },
};

interface Body {
  pfxBase64?: string;
  senha?: string;
  cnpjMedwork?: string;
  razaoSocial?: string;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  Object.entries(corsHeaders).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { pfxBase64, senha, cnpjMedwork, razaoSocial }: Body = req.body || {};
    if (!pfxBase64 || !senha) {
      return res.status(400).json({ error: "pfxBase64 e senha são obrigatórios" });
    }

    const pfxBuffer = Buffer.from(pfxBase64, "base64");
    const p12Asn1 = forge.asn1.fromDer(forge.util.createBuffer(pfxBuffer.toString("binary")));
    let p12: forge.pkcs12.Pkcs12Pfx;
    try {
      p12 = forge.pkcs12.pkcs12FromAsn1(p12Asn1, false, senha);
    } catch {
      return res.status(400).json({ error: "Senha do certificado inválida" });
    }

    const certBags = p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] || [];
    const cert = certBags[0]?.cert;
    if (!cert) return res.status(400).json({ error: "Certificado não encontrado no .pfx" });

    const subject = cert.subject.attributes
      .map((a) => `${a.shortName ?? a.name}=${a.value}`)
      .join(", ");
    const cnAttr = cert.subject.getField("CN");
    const subjectCN = cnAttr?.value ?? subject;
    const validFrom = cert.validity.notBefore.toISOString();
    const validTo = cert.validity.notAfter.toISOString();
    if (cert.validity.notAfter < new Date()) {
      return res.status(400).json({ error: `Certificado vencido em ${validTo}` });
    }

    // Extract CNPJ from CN (typical format: "RAZAO SOCIAL:14digitos")
    const fromCnMatch = subjectCN.match(/:(\d{14})/) || subjectCN.match(/(\d{14})/);
    const cnpjFromCert = fromCnMatch ? fromCnMatch[1] : null;
    const finalCnpj = (cnpjMedwork || cnpjFromCert || "").replace(/\D/g, "");
    if (!finalCnpj || finalCnpj.length !== 14) {
      return res.status(400).json({
        error: `CNPJ não encontrado no certificado (CN: "${subjectCN}"). Passe cnpjMedwork manualmente.`,
      });
    }

    // Extract razão social from CN (everything before ":14digitos")
    const razaoFromCn = subjectCN.replace(/:\d{14}.*$/, "").trim();

    const sb = supaAdmin();
    const cnpjDigits = finalCnpj;
    const storagePath = `${cnpjDigits}/cert-${Date.now()}.pfx`;

    const { error: upErr } = await sb.storage
      .from("certificados-esocial")
      .upload(storagePath, pfxBuffer, {
        contentType: "application/x-pkcs12",
        upsert: true,
      });
    if (upErr) throw upErr;

    const senhaCifrada = encryptSecret(senha);

    await sb.from("esocial_certificado").update({ ativo: false }).eq("ativo", true);

    const { data: row, error: insertErr } = await sb
      .from("esocial_certificado")
      .upsert(
        {
          cnpj: cnpjDigits,
          razao_social: razaoSocial || razaoFromCn || subjectCN,
          storage_path: storagePath,
          senha_cifrada: senhaCifrada,
          subject_cn: subjectCN,
          valido_de: validFrom,
          valido_ate: validTo,
          ativo: true,
        },
        { onConflict: "cnpj" }
      )
      .select()
      .single();
    if (insertErr) throw insertErr;

    return res.status(200).json({
      ok: true,
      certificate: {
        id: row.id,
        cnpj: row.cnpj,
        razao_social: row.razao_social,
        subject_cn: row.subject_cn,
        valido_de: row.valido_de,
        valido_ate: row.valido_ate,
      },
    });
  } catch (err: any) {
    console.error("[upload-cert] error", err);
    return res.status(500).json({ error: err?.message || "Erro no upload" });
  }
}
