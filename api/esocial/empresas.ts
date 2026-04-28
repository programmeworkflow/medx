import type { VercelRequest, VercelResponse } from "@vercel/node";
import { supaAdmin, corsHeaders } from "./_lib.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  Object.entries(corsHeaders).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === "OPTIONS") return res.status(204).end();
  const sb = supaAdmin();

  try {
    if (req.method === "GET") {
      const { data, error } = await sb
        .from("esocial_empresas_sync")
        .select("*")
        .order("razao_social");
      if (error) throw error;
      return res.status(200).json({ empresas: data });
    }

    if (req.method === "POST") {
      const { cnpj, razao_social } = req.body || {};
      if (!cnpj) return res.status(400).json({ error: "cnpj obrigatório" });
      const cnpjDigits = String(cnpj).replace(/\D/g, "");
      if (cnpjDigits.length !== 14)
        return res.status(400).json({ error: "CNPJ inválido (14 dígitos)" });

      const { data, error } = await sb
        .from("esocial_empresas_sync")
        .upsert(
          { cnpj: cnpjDigits, razao_social: razao_social || null, ativo: true },
          { onConflict: "cnpj" }
        )
        .select()
        .single();
      if (error) throw error;
      return res.status(200).json({ empresa: data });
    }

    if (req.method === "DELETE") {
      const id = (req.body?.id || req.query.id) as string | undefined;
      if (!id) return res.status(400).json({ error: "id obrigatório" });
      const { error } = await sb.from("esocial_empresas_sync").delete().eq("id", id);
      if (error) throw error;
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || "Erro" });
  }
}
