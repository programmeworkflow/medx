import type { VercelRequest, VercelResponse } from "@vercel/node";
import { supaAdmin, decryptSecret, corsHeaders } from "./_lib.js";
import { pingEsocial } from "./_soap.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  Object.entries(corsHeaders).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const sb = supaAdmin();
    const { data: cert } = await sb
      .from("esocial_certificado")
      .select("*")
      .eq("ativo", true)
      .maybeSingle();
    if (!cert) return res.status(400).json({ ok: false, error: "Nenhum certificado ativo" });

    const { data: pfxData, error: dlErr } = await sb.storage
      .from("certificados-esocial")
      .download(cert.storage_path);
    if (dlErr || !pfxData) throw dlErr || new Error("Falha ao baixar .pfx");

    const senha = decryptSecret(cert.senha_cifrada);
    const ab = await pfxData.arrayBuffer();
    const pfxBuf = Buffer.from(ab);

    const ping = await pingEsocial({ pfx: pfxBuf, senha, cnpj14: cert.cnpj });

    return res.status(200).json({
      ok: ping.ok,
      cdResposta: ping.cdResposta,
      descResposta: ping.descResposta,
      cert_validade: cert.valido_ate,
      cnpj: cert.cnpj,
      subject_cn: cert.subject_cn,
      message: ping.ok
        ? `Conexão validada. eSocial respondeu cdResposta=${ping.cdResposta} (${ping.descResposta}). Procuração da Medwork sobre si mesma OK — autenticação funcional.`
        : `Falha: cdResposta=${ping.cdResposta} (${ping.descResposta})`,
    });
  } catch (err: any) {
    return res.status(500).json({ ok: false, error: err?.message || "Erro" });
  }
}
