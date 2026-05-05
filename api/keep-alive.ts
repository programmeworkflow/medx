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

  // 2. Disparos em background (fire-and-forget):
  //   - minuto 0-2:   sync eSocial (consulta governo, 1 empresa)
  //   - minuto 15-17: sync-retencao (1 chunk de 20 empresas, se houver pendente)
  //   - minuto 30-32: sync-workers-cursor (popula CPFs do ESO, 40 empresas)
  //   - minuto 45-47: sync-retencao (mais 1 chunk, se houver pendente)
  let triggered: string[] = [];
  if (minute < 3) {
    triggered.push("esocial-sync");
    fetch("https://medx-flow-mocha.vercel.app/api/esocial/sync?next=1", { method: "GET" }).catch(() => {});
  } else if (minute >= 15 && minute < 18) {
    triggered.push("retencao-sync");
    fetch("https://medx-flow-mocha.vercel.app/api/contaazul/sync-retencao?offset=0&limit=20", { method: "GET" }).catch(() => {});
  } else if (minute >= 30 && minute < 33) {
    triggered.push("eso-workers-cursor");
    fetch("https://medx-flow-mocha.vercel.app/api/eso/sync-workers-cursor?limit=40", { method: "GET" }).catch(() => {});
  } else if (minute >= 45 && minute < 48) {
    triggered.push("retencao-sync");
    fetch("https://medx-flow-mocha.vercel.app/api/contaazul/sync-retencao?offset=0&limit=20", { method: "GET" }).catch(() => {});
  }

  return res.status(200).json({
    ok: true,
    backend,
    triggered,
    minute,
    at: now.toISOString(),
  });
}
