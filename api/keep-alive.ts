// Endpoint público pra UptimeRobot — pinga o Render e retorna 200.
// Mantém o backend Render quente (free tier dorme após 15min).
import type { VercelRequest, VercelResponse } from "@vercel/node";

export default async function handler(_req: VercelRequest, res: VercelResponse) {
  const t0 = Date.now();
  let backend = { status: 0, ms: 0, error: null as string | null };
  try {
    const r = await fetch("https://contratos-medwork.onrender.com/api/auth/me", {
      method: "GET",
      // Timeout via AbortSignal — não quero travar o ping
      signal: AbortSignal.timeout(60000),
    });
    backend.status = r.status;
  } catch (err: any) {
    backend.error = err?.message || String(err);
  } finally {
    backend.ms = Date.now() - t0;
  }
  return res.status(200).json({
    ok: true,
    backend,
    at: new Date().toISOString(),
  });
}
