import type { VercelRequest, VercelResponse } from "@vercel/node";
import { supaAdmin, decryptSecret, corsHeaders } from "./_lib.js";
import {
  pfxToPem,
  makeAgent,
  envelopeConsultaTrabalhador,
  envelopeSolicitarDownload,
  parseRetornoConsulta,
  parseEventoFuncionario,
  postSoap,
  fmtBRT,
  dtFimAgora,
} from "./_soap.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  Object.entries(corsHeaders).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const empresaId: string | undefined = req.body?.id;
    const sb = supaAdmin();

    // 1. Carrega cert ativo
    const { data: cert } = await sb
      .from("esocial_certificado")
      .select("*")
      .eq("ativo", true)
      .maybeSingle();
    if (!cert) return res.status(400).json({ error: "Nenhum certificado ativo configurado" });
    const { data: pfxData } = await sb.storage
      .from("certificados-esocial")
      .download(cert.storage_path);
    if (!pfxData) throw new Error("Falha ao baixar .pfx do bucket");
    const pfxBuf = Buffer.from(await pfxData.arrayBuffer());
    const senha = decryptSecret(cert.senha_cifrada);
    const pem = pfxToPem(pfxBuf, senha);
    const agent = makeAgent(pfxBuf, senha);

    // 2. Busca empresa(s)
    const empresasQ = sb.from("esocial_empresas_sync").select("*").eq("ativo", true);
    if (empresaId) empresasQ.eq("id", empresaId);
    const { data: empresas, error: emprErr } = await empresasQ;
    if (emprErr) throw emprErr;
    if (!empresas?.length) {
      return res.status(400).json({ error: "Nenhuma empresa configurada para sync" });
    }

    const stats: any = { empresas: empresas.length, cpfsConsultados: 0, idsRetornados: 0, eventosBaixados: 0, atualizacoes: 0, erros: [] as any[] };
    const dtFim = dtFimAgora();
    const dtIni = fmtBRT(new Date(Date.now() - 30 * 24 * 3600 * 1000));

    for (const empresa of empresas) {
      const cnpj14 = empresa.cnpj;
      // 3. Busca CPFs cadastrados pra essa empresa
      const { data: cpfs } = await sb
        .from("esocial_funcionarios")
        .select("cpf, nome, situacao")
        .eq("empresa_cnpj", cnpj14);
      if (!cpfs?.length) {
        stats.erros.push({ cnpj: cnpj14, erro: "Sem CPFs cadastrados — importe lista primeiro" });
        continue;
      }

      const idsParaBaixar: string[] = [];
      for (const f of cpfs) {
        try {
          stats.cpfsConsultados++;
          const { xml, endpoint } = envelopeConsultaTrabalhador({
            cnpj14, cpf: f.cpf, dtIni, dtFim, pem,
          });
          const r = await postSoap(endpoint, xml, agent);
          if (r.status !== 200) {
            stats.erros.push({ cnpj: cnpj14, cpf: f.cpf, erro: `HTTP ${r.status}` });
            continue;
          }
          const ret = parseRetornoConsulta(r.body);
          stats.idsRetornados += ret.identificadores.length;
          for (const i of ret.identificadores) {
            if (i.id) idsParaBaixar.push(i.id);
          }
        } catch (e: any) {
          stats.erros.push({ cnpj: cnpj14, cpf: f.cpf, erro: e?.message });
        }
      }

      // 4. Solicitar download em lotes de 10
      for (let k = 0; k < idsParaBaixar.length; k += 10) {
        const ids = idsParaBaixar.slice(k, k + 10);
        try {
          const { xml, endpoint } = envelopeSolicitarDownload({ cnpj14, ids, pem });
          const r = await postSoap(endpoint, xml, agent);
          if (r.status !== 200) continue;
          // resposta contém os XMLs dos eventos — parse cada
          // (estrutura: eSocial.retornoSolicDownloadEvtsPorId.dadosDownload[].xml)
          const matches = r.body.match(/<arquivoEsocial[^>]*>[\s\S]*?<\/arquivoEsocial>/g) || [];
          stats.eventosBaixados += matches.length;
          for (const evtXml of matches) {
            try {
              // base64 → xml decodificado
              const b64 = evtXml.replace(/<\/?arquivoEsocial[^>]*>/g, "").trim();
              const decoded = Buffer.from(b64, "base64").toString("utf8");
              const parsed = parseEventoFuncionario(decoded);
              if (!parsed.tipo || !parsed.cpf) continue;

              const update: any = {};
              if (parsed.tipo === "S-2200" || parsed.tipo === "S-2300") {
                update.data_admissao = parsed.dataAdmissao;
                update.situacao = "ativo";
              } else if (parsed.tipo === "S-2299" || parsed.tipo === "S-2399") {
                update.data_desligamento = parsed.dataDesligamento;
                update.situacao = "desligado";
              } else if (parsed.tipo === "S-2230") {
                update.situacao = "afastado";
                update.motivo_afastamento = parsed.motivoAfastamento;
              }
              if (parsed.nome && parsed.nome.length > 2) update.nome = parsed.nome;
              update.ultima_atualizacao = new Date().toISOString();

              const { error: updErr } = await sb
                .from("esocial_funcionarios")
                .update(update)
                .eq("empresa_cnpj", cnpj14)
                .eq("cpf", parsed.cpf);
              if (!updErr) stats.atualizacoes++;

              await sb.from("esocial_eventos_log").insert({
                empresa_cnpj: cnpj14,
                tipo_evento: parsed.tipo,
                evento_id: null,
                raw_xml: decoded.slice(0, 50000),
              });
            } catch (e: any) {
              stats.erros.push({ erro: `parseEvt: ${e?.message}` });
            }
          }
        } catch (e: any) {
          stats.erros.push({ cnpj: cnpj14, erro: `download: ${e?.message}` });
        }
      }

      await sb
        .from("esocial_empresas_sync")
        .update({ ultimo_sync: new Date().toISOString() })
        .eq("id", empresa.id);
    }

    return res.status(200).json({ ok: true, stats });
  } catch (err: any) {
    return res.status(500).json({ ok: false, error: err?.message || "Erro no sync" });
  }
}
