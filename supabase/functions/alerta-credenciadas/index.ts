// Supabase Edge Function — Alertas de reajuste de credenciadas
//
// Propósito: roda diariamente (via pg_cron) e envia um email pro
// administrador com a lista de credenciadas que:
//   - completam 1 ano de contrato HOJE ou nos próximos 7 dias → reajuste
//   - estão com contrato > 2 anos sem atualização → alerta crítico
//
// Configuração necessária:
//   - ENV: RESEND_API_KEY   (https://resend.com — plano free suficiente)
//   - ENV: ALERTA_EMAIL_TO  (ex: "admin@medwork.com")
//   - ENV: ALERTA_EMAIL_FROM (ex: "alertas@medwork.com" — domínio verificado no Resend)
//
// Se RESEND_API_KEY não estiver setada, a função apenas retorna a lista
// pra inspeção (modo dry-run), sem falhar.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
const ALERTA_EMAIL_TO = Deno.env.get("ALERTA_EMAIL_TO");
const ALERTA_EMAIL_FROM = Deno.env.get("ALERTA_EMAIL_FROM") || "alertas@medwork.com";

type Credenciada = {
  id: string;
  nome: string;
  cnpj: string;
  data_contrato: string | null;
  email_faturamento: string | null;
};

function classificaReajuste(
  data_contrato: string | null
): "reajuste_proximo" | "atrasado_1ano" | "atrasado_2anos" | null {
  if (!data_contrato) return null;
  const d = new Date(data_contrato);
  const hoje = new Date();
  const diffDias = Math.floor((hoje.getTime() - d.getTime()) / (1000 * 60 * 60 * 24));
  if (diffDias >= 730) return "atrasado_2anos";
  if (diffDias >= 365) return "atrasado_1ano";
  const diasPrimeiroAniv = 365 - diffDias;
  if (diasPrimeiroAniv >= 0 && diasPrimeiroAniv <= 7) return "reajuste_proximo";
  return null;
}

function renderEmailHtml(grupos: {
  reajuste_proximo: Credenciada[];
  atrasado_1ano: Credenciada[];
  atrasado_2anos: Credenciada[];
}): string {
  const tbl = (title: string, rows: Credenciada[], color: string) => {
    if (rows.length === 0) return "";
    return `
      <h3 style="color:${color};margin:16px 0 8px;font-family:system-ui,-apple-system,sans-serif">${title} (${rows.length})</h3>
      <table cellpadding="8" cellspacing="0" border="1" style="border-collapse:collapse;font-family:system-ui,-apple-system,sans-serif;font-size:13px;width:100%">
        <thead style="background:#f5f5f5">
          <tr>
            <th align="left">Credenciada</th>
            <th align="left">CNPJ</th>
            <th align="left">Data do contrato</th>
            <th align="left">E-mail faturamento</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map(c => `
            <tr>
              <td>${c.nome}</td>
              <td style="font-family:monospace">${c.cnpj}</td>
              <td>${c.data_contrato ? new Date(c.data_contrato).toLocaleDateString("pt-BR") : "—"}</td>
              <td>${c.email_faturamento || "—"}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    `;
  };

  return `<!doctype html>
<html><body style="font-family:system-ui,-apple-system,sans-serif;color:#333;padding:16px;max-width:720px;margin:0 auto">
  <h2 style="color:#0f766e;margin:0 0 4px">MedX — Alerta de Reajuste de Credenciadas</h2>
  <p style="color:#666;margin:0 0 16px;font-size:13px">${new Date().toLocaleDateString("pt-BR", { dateStyle: "long" })}</p>
  ${tbl("🚨 Contratos com +2 anos sem atualização", grupos.atrasado_2anos, "#b91c1c")}
  ${tbl("⚠️ Reajuste vencido (completou 1 ano)",     grupos.atrasado_1ano, "#d97706")}
  ${tbl("⏰ Completam 1 ano nos próximos 7 dias",   grupos.reajuste_proximo, "#0891b2")}
  <p style="color:#999;font-size:12px;margin-top:32px">Este email é enviado automaticamente pela função <code>alerta-credenciadas</code>.</p>
</body></html>`;
}

async function enviarEmailViaResend(
  to: string,
  subject: string,
  html: string
): Promise<{ ok: boolean; error?: string }> {
  if (!RESEND_API_KEY) return { ok: false, error: "RESEND_API_KEY not set" };

  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: ALERTA_EMAIL_FROM,
      to: [to],
      subject,
      html,
    }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    return { ok: false, error: `Resend ${resp.status}: ${text}` };
  }
  return { ok: true };
}

Deno.serve(async (_req) => {
  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { data, error } = await supabase
      .from("credenciadas")
      .select("id, nome, cnpj, data_contrato, email_faturamento")
      .eq("ativa", true)
      .not("data_contrato", "is", null);

    if (error) throw error;
    const all = (data || []) as Credenciada[];

    const grupos = {
      reajuste_proximo: [] as Credenciada[],
      atrasado_1ano:    [] as Credenciada[],
      atrasado_2anos:   [] as Credenciada[],
    };
    for (const c of all) {
      const cat = classificaReajuste(c.data_contrato);
      if (cat) grupos[cat].push(c);
    }

    const total = grupos.reajuste_proximo.length + grupos.atrasado_1ano.length + grupos.atrasado_2anos.length;

    // Nada a alertar
    if (total === 0) {
      return new Response(JSON.stringify({ ok: true, total: 0, message: "Nenhum alerta." }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    const html = renderEmailHtml(grupos);

    let emailResult: { ok: boolean; error?: string } = { ok: false, error: "skipped — no ALERTA_EMAIL_TO" };
    if (ALERTA_EMAIL_TO) {
      emailResult = await enviarEmailViaResend(
        ALERTA_EMAIL_TO,
        `MedX — ${total} credenciada(s) com reajuste pendente`,
        html
      );
    }

    return new Response(
      JSON.stringify({
        ok: true,
        total,
        resumo: {
          reajuste_proximo: grupos.reajuste_proximo.length,
          atrasado_1ano:    grupos.atrasado_1ano.length,
          atrasado_2anos:   grupos.atrasado_2anos.length,
        },
        email: emailResult,
      }),
      { headers: { "Content-Type": "application/json" } }
    );
  } catch (err: any) {
    return new Response(JSON.stringify({ ok: false, error: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
