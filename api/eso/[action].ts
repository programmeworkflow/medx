import type { VercelRequest, VercelResponse } from "@vercel/node";
import { supaAdmin, corsHeaders } from "../esocial/_lib.js";
import { getEsoSession, listAllCompanies, listWorkersOf } from "./_eso.js";

export const config = { maxDuration: 60 };

async function syncCompanies() {
  const email = process.env.ESO_EMAIL!;
  const pass = process.env.ESO_PASSWORD!;
  const t0 = Date.now();
  const jar = await getEsoSession(email, pass);
  const companies = await listAllCompanies(jar);
  const employers = companies.filter(
    (c) => c.IsEmployer && c.BusinessDocumentTypeName === "CNPJ"
  );
  const sb = supaAdmin();
  const map = new Map<string, any>();
  for (const c of employers) {
    const cnpj = c.DocumentNumber.replace(/\D/g, "");
    if (cnpj.length !== 14) continue;
    map.set(cnpj, { cnpj, razao_social: c.SocialName || c.Name, ativo: true });
  }
  const rows = [...map.values()];
  let upserted = 0;
  const erros: any[] = [];
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const { error } = await sb.from("esocial_empresas_sync").upsert(chunk, { onConflict: "cnpj" });
    if (error) erros.push({ chunk: i, erro: error.message });
    else upserted += chunk.length;
  }
  return {
    ok: true,
    empresasTotaisESO: companies.length,
    empresasEmployer: employers.length,
    upserted,
    erros: erros.slice(0, 20),
    duracaoMs: Date.now() - t0,
  };
}

async function syncWorkers(offset = 0, limit = 40) {
  const email = process.env.ESO_EMAIL!;
  const pass = process.env.ESO_PASSWORD!;
  const t0 = Date.now();
  const jar = await getEsoSession(email, pass);
  const all = await listAllCompanies(jar);
  const employers = all.filter(
    (c) => c.IsEmployer && c.BusinessDocumentTypeName === "CNPJ"
  );
  const chunk = employers.slice(offset, offset + limit);
  const sb = supaAdmin();
  let upserted = 0;
  const erros: any[] = [];
  for (const c of chunk) {
    const cnpj = c.DocumentNumber.replace(/\D/g, "");
    if (cnpj.length !== 14) continue;
    try {
      const workers = await listWorkersOf(jar, c.Id);
      const rows = workers
        .filter((w) => w.Cpf && w.Cpf.length === 11)
        .map((w) => ({
          empresa_cnpj: cnpj,
          cpf: w.Cpf,
          nome: w.Name || null,
          data_admissao: w.AdmissionDate ? w.AdmissionDate.slice(0, 10) : null,
          data_desligamento: w.TerminationDate ? w.TerminationDate.slice(0, 10) : null,
          situacao: w.TerminationDate ? "desligado" : "ativo",
        }));
      if (rows.length) {
        const { error } = await sb
          .from("esocial_funcionarios")
          .upsert(rows, { onConflict: "empresa_cnpj,cpf" });
        if (error) erros.push({ cnpj, erro: error.message });
        else upserted += rows.length;
      }
    } catch (e: any) {
      erros.push({ cnpj, erro: e?.message });
    }
  }
  return {
    ok: true,
    processadas: chunk.length,
    cpfsUpserted: upserted,
    offset,
    nextOffset: offset + chunk.length < employers.length ? offset + chunk.length : null,
    totalEmpresas: employers.length,
    duracaoMs: Date.now() - t0,
    erros: erros.slice(0, 10),
  };
}

async function syncWorkersCursor(limit = 40) {
  const sb = supaAdmin();
  let { data: state } = await sb.from("eso_sync_state").select("*").eq("id", 1).maybeSingle();
  if (!state) {
    const { data } = await sb
      .from("eso_sync_state")
      .insert({ id: 1, last_offset: 0, total_empresas: 0, ciclo_iniciado_em: new Date().toISOString() })
      .select()
      .single();
    state = data;
  }

  const email = process.env.ESO_EMAIL!;
  const pass = process.env.ESO_PASSWORD!;
  const t0 = Date.now();
  const jar = await getEsoSession(email, pass);
  const all = await listAllCompanies(jar);
  const employers = all.filter((c) => c.IsEmployer && c.BusinessDocumentTypeName === "CNPJ");
  const startOffset = (state?.last_offset ?? 0) >= employers.length ? 0 : (state?.last_offset ?? 0);
  const cicloReset = startOffset === 0 && (state?.last_offset ?? 0) > 0;
  const chunk = employers.slice(startOffset, startOffset + limit);

  let upserted = 0;
  const erros: any[] = [];
  for (const c of chunk) {
    const cnpj = c.DocumentNumber.replace(/\D/g, "");
    if (cnpj.length !== 14) continue;
    try {
      const workers = await listWorkersOf(jar, c.Id);
      const rows = workers
        .filter((w) => w.Cpf && w.Cpf.length === 11)
        .map((w) => ({
          empresa_cnpj: cnpj,
          cpf: w.Cpf,
          nome: w.Name || null,
          data_admissao: w.AdmissionDate ? w.AdmissionDate.slice(0, 10) : null,
          data_desligamento: w.TerminationDate ? w.TerminationDate.slice(0, 10) : null,
          situacao: w.TerminationDate ? "desligado" : "ativo",
        }));
      if (rows.length) {
        const { error } = await sb
          .from("esocial_funcionarios")
          .upsert(rows, { onConflict: "empresa_cnpj,cpf" });
        if (error) erros.push({ cnpj, erro: error.message });
        else upserted += rows.length;
      }
    } catch (e: any) {
      erros.push({ cnpj, erro: e?.message });
    }
  }

  const newOffset = startOffset + chunk.length;
  const cicloCompleto = newOffset >= employers.length;
  const finalOffset = cicloCompleto ? 0 : newOffset;
  await sb
    .from("eso_sync_state")
    .update({
      last_offset: finalOffset,
      total_empresas: employers.length,
      ultima_run_at: new Date().toISOString(),
      ...(cicloReset ? { ciclo_iniciado_em: new Date().toISOString() } : {}),
      ...(cicloCompleto ? { ultimo_ciclo_completo_em: new Date().toISOString() } : {}),
    })
    .eq("id", 1);

  return {
    ok: true,
    processadas: chunk.length,
    cpfsUpserted: upserted,
    offset: startOffset,
    newOffset: finalOffset,
    cicloCompleto,
    totalEmpresas: employers.length,
    duracaoMs: Date.now() - t0,
    erros: erros.slice(0, 10),
  };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  Object.entries(corsHeaders).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === "OPTIONS") return res.status(204).end();

  const action = String(req.query.action || "").toLowerCase();
  if (!process.env.ESO_EMAIL || !process.env.ESO_PASSWORD) {
    return res.status(500).json({ error: "ESO_EMAIL/ESO_PASSWORD não configurados" });
  }

  try {
    if (action === "sync" || action === "sync-companies") {
      const r = await syncCompanies();
      return res.status(200).json(r);
    }
    if (action === "sync-workers") {
      const offset = Number(req.query.offset ?? 0);
      const limit = Number(req.query.limit ?? 40);
      const r = await syncWorkers(offset, limit);
      return res.status(200).json(r);
    }
    if (action === "sync-workers-cursor") {
      const limit = Number(req.query.limit ?? 40);
      const r = await syncWorkersCursor(limit);
      return res.status(200).json(r);
    }
    return res.status(404).json({ error: `action desconhecida: ${action}` });
  } catch (err: any) {
    return res.status(500).json({ ok: false, error: err?.message });
  }
}
