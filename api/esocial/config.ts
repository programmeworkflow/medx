import type { VercelRequest, VercelResponse } from "@vercel/node";
import { supaAdmin, corsHeaders } from "./_lib.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  Object.entries(corsHeaders).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  try {
    const sb = supaAdmin();
    const { data, error } = await sb
      .from("esocial_certificado")
      .select("id, cnpj, razao_social, subject_cn, valido_de, valido_ate, ativo, uploaded_at")
      .eq("ativo", true)
      .order("uploaded_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;

    const { count: empresasCount } = await sb
      .from("esocial_empresas_sync")
      .select("*", { count: "exact", head: true });

    const { count: funcsCount } = await sb
      .from("esocial_funcionarios")
      .select("*", { count: "exact", head: true });

    return res.status(200).json({
      config: data
        ? {
            ...data,
            cnpj_titular: data.cnpj,
            valid_until: data.valido_ate,
            valid_from: data.valido_de,
          }
        : null,
      stats: {
        empresas: empresasCount ?? 0,
        funcionarios: funcsCount ?? 0,
      },
    });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || "Erro ao carregar config" });
  }
}
