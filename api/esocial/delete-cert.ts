import type { VercelRequest, VercelResponse } from "@vercel/node";
import { supaAdmin, corsHeaders } from "./_lib.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  Object.entries(corsHeaders).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST" && req.method !== "DELETE") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const id = (req.body?.id || req.query.id) as string | undefined;
    if (!id) return res.status(400).json({ error: "id obrigatório" });

    const sb = supaAdmin();
    const { data: row } = await sb
      .from("esocial_certificado")
      .select("storage_path")
      .eq("id", id)
      .maybeSingle();
    if (row?.storage_path) {
      await sb.storage.from("certificados-esocial").remove([row.storage_path]);
    }
    const { error } = await sb.from("esocial_certificado").delete().eq("id", id);
    if (error) throw error;
    return res.status(200).json({ ok: true });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || "Erro ao remover" });
  }
}
