import type { VercelRequest, VercelResponse } from "@vercel/node";
import { supaAdmin, corsHeaders } from "./_lib.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  Object.entries(corsHeaders).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  try {
    const empresaCnpj = (req.query.empresa_id as string) || (req.query.cnpj as string);
    const situacao = (req.query.situacao as string) || "";
    const page = parseInt((req.query.page as string) || "1", 10);
    const pageSize = parseInt((req.query.pageSize as string) || "25", 10);

    const sb = supaAdmin();
    let q = sb.from("esocial_funcionarios").select("*", { count: "exact" });
    if (empresaCnpj) q = q.eq("empresa_cnpj", empresaCnpj.replace(/\D/g, ""));
    if (situacao) q = q.eq("situacao", situacao);
    const from = (page - 1) * pageSize;
    const to = from + pageSize - 1;
    q = q.range(from, to).order("nome");

    const { data, count, error } = await q;
    if (error) throw error;

    return res.status(200).json({
      funcionarios: data || [],
      total: count || 0,
      totalPages: Math.ceil((count || 0) / pageSize),
      page,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || "Erro" });
  }
}
