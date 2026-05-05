// Endpoint público pra UptimeRobot — pinga Render + dispara sync eSocial.
// 1) Mantém Render quente (free tier dorme após 15min)
// 2) A cada 30 min (minuto 0 e 30), dispara sync de 1 empresa (fire-and-forget)
import type { VercelRequest, VercelResponse } from "@vercel/node";

export default async function handler(_req: VercelRequest, res: VercelResponse) {
  const now = new Date();
  const minute = now.getUTCMinutes();
  const t0 = Date.now();
  let backend = { status: 0, ms: 0, error: null as string | null };
  let syncTriggered = false;

  // 1. Ping Render (sempre)
  try {
    const r = await fetch("https://contratos-medwork.onrender.com/api/auth/me", {
      method: "GET",
      signal: AbortSignal.timeout(60000),
    });
    backend.status = r.status;
  } catch (err: any) {
    backend.error = err?.message || String(err);
  } finally {
    backend.ms = Date.now() - t0;
  }

  // 2. A cada 30 min (minuto 0-2 ou 30-32 — janela de tolerância de 3min)
  // dispara sync eSocial em background (não esperamos a resposta)
  if (minute < 3 || (minute >= 30 && minute < 33)) {
    syncTriggered = true;
    // Fire-and-forget — não usamos await
    fetch("https://medx-flow-mocha.vercel.app/api/esocial/sync?next=1", {
      method: "GET",
    }).catch(() => {});
  }

  return res.status(200).json({
    ok: true,
    backend,
    sync_triggered: syncTriggered,
    minute,
    at: now.toISOString(),
  });
}
