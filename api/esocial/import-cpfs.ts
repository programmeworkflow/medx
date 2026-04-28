import type { VercelRequest, VercelResponse } from "@vercel/node";
import { supaAdmin, corsHeaders } from "./_lib.js";

interface CpfRow {
  cnpj: string;
  cpf: string;
  nome?: string;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  Object.entries(corsHeaders).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const rows: CpfRow[] = req.body?.rows || [];
    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ error: "Body precisa ter { rows: [{cnpj, cpf, nome?}, ...] }" });
    }

    const sb = supaAdmin();

    // Garante que cada CNPJ existe em esocial_empresas_sync (FK requirement)
    const cnpjs = Array.from(new Set(rows.map((r) => (r.cnpj || "").replace(/\D/g, ""))));
    for (const cnpj of cnpjs) {
      if (cnpj.length !== 14) continue;
      await sb
        .from("esocial_empresas_sync")
        .upsert({ cnpj, ativo: true }, { onConflict: "cnpj" });
    }

    const inserts = rows
      .map((r) => ({
        empresa_cnpj: (r.cnpj || "").replace(/\D/g, ""),
        cpf: (r.cpf || "").replace(/\D/g, ""),
        nome: r.nome || null,
        situacao: "ativo",
      }))
      .filter((r) => r.empresa_cnpj.length === 14 && r.cpf.length === 11);

    if (!inserts.length) {
      return res.status(400).json({ error: "Nenhuma linha válida (CNPJ 14 dígitos + CPF 11 dígitos)" });
    }

    const { data, error } = await sb
      .from("esocial_funcionarios")
      .upsert(inserts, { onConflict: "empresa_cnpj,cpf" })
      .select("id, empresa_cnpj, cpf");
    if (error) throw error;

    return res.status(200).json({
      ok: true,
      inseridos: data?.length || 0,
      cnpjsAfetados: cnpjs.length,
      total_linhas_validas: inserts.length,
      total_linhas_recebidas: rows.length,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || "Erro" });
  }
}
