// Envia e-mail "Segue o link da fatura" via Gmail SMTP — usado quando
// a CA bloqueia URLs no body (anti-phishing) e precisamos disparar
// o link separado. Funciona como complemento ao envio CA.
//
// ENV vars exigidas:
//   GMAIL_USER             — endereço Gmail remetente (ex: medwork.financeiro@gmail.com)
//   GMAIL_APP_PASSWORD     — App Password gerada em myaccount.google.com/apppasswords
//                            (precisa 2FA ativo na conta Google)
//
// Limite Gmail conta normal: 500 e-mails/dia. Pra 700 clientes/mês,
// o user fatura em 2 dias (manda metade quinta, metade sexta).

import type { VercelRequest, VercelResponse } from "@vercel/node";
import nodemailer from "nodemailer";
import { corsHeaders } from "../esocial/_lib.js";

let transporter: nodemailer.Transporter | null = null;
function getTransporter() {
  if (transporter) return transporter;
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) {
    throw new Error("GMAIL_USER e GMAIL_APP_PASSWORD precisam estar configurados no Vercel");
  }
  transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user, pass: pass.replace(/\s+/g, "") }, // app password vem com espaços às vezes
  });
  return transporter;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  Object.entries(corsHeaders).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const body: any = req.body || {};
    const destinatarios: string[] = Array.isArray(body.destinatarios)
      ? body.destinatarios.filter((e: string) => e && e.includes("@"))
      : [];
    const link = String(body.link || "").trim();              // ESO (legado/opcional)
    const linkEso = String(body.link_eso || link || "").trim();
    const linkBoleto = String(body.link_boleto || "").trim();
    const linhaDigitavel = String(body.linha_digitavel || "").trim();
    const linkNf = String(body.link_nf || "").trim();
    const numeroNf = body.numero_nf ? String(body.numero_nf) : "";
    const valor = body.valor ? Number(body.valor) : null;
    const dataVencimento = String(body.data_vencimento || "").trim();
    const empresaNome = String(body.empresa_nome || "").trim();
    const numeroVenda = body.numero_venda ? String(body.numero_venda) : "";
    // Link público da fatura no CA (mostra boleto + NF + valor com retenção)
    const vendaIdCA = String(body.venda_id_ca || "").trim();
    const linkFaturaCA = vendaIdCA ? `https://app.contaazul.com/pub/#/invoice/v2/${vendaIdCA}` : "";
    const cc: string[] = Array.isArray(body.cc)
      ? body.cc.filter((e: string) => e && e.includes("@"))
      : [];

    if (destinatarios.length === 0) {
      return res.status(400).json({ error: "destinatarios obrigatório (array de emails)" });
    }
    if (!linkEso && !linkBoleto && !linkNf && !linhaDigitavel && !linkFaturaCA) {
      return res.status(400).json({ error: "informe ao menos 1 link" });
    }

    const fmtMoney = (v: number | null) =>
      v == null ? "" : v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
    const fmtDate = (d: string) => {
      if (!d) return "";
      try { return new Date(d).toLocaleDateString("pt-BR"); } catch { return d; }
    };

    const t = getTransporter();
    const fromUser = process.env.GMAIL_USER!;
    const subject = numeroVenda
      ? `Cobrança Medwork — Venda Nº ${numeroVenda}`
      : `Cobrança Medwork`;

    // Texto plain pra clientes de email simples
    const blocos: string[] = [];
    blocos.push(empresaNome ? `Olá ${empresaNome},` : "Olá,");
    blocos.push("");
    blocos.push("Segue a sua cobrança da Medwork:");
    if (valor) blocos.push(`Valor: ${fmtMoney(valor)}`);
    if (dataVencimento) blocos.push(`Vencimento: ${fmtDate(dataVencimento)}`);
    blocos.push("");
    if (linkFaturaCA) {
      blocos.push("FATURA (boleto + nota fiscal):");
      blocos.push(linkFaturaCA);
      blocos.push("");
    }
    if (linkBoleto && !linkFaturaCA) {
      blocos.push("BOLETO:");
      blocos.push(linkBoleto);
      if (linhaDigitavel) blocos.push(`Linha digitável: ${linhaDigitavel}`);
      blocos.push("");
    }
    if (linkNf && !linkFaturaCA) {
      blocos.push(`NOTA FISCAL${numeroNf ? ` Nº ${numeroNf}` : ""}:`);
      blocos.push(linkNf);
      blocos.push("");
    }
    if (linkEso) {
      blocos.push("RELATÓRIO ESO:");
      blocos.push(linkEso);
      blocos.push("");
    }
    blocos.push("Qualquer dúvida estamos à disposição.");
    blocos.push("");
    blocos.push("— Medwork");
    const text = blocos.join("\n");

    // HTML formatado, didático
    const blocoHtml = (titulo: string, conteudo: string) =>
      `<div style="margin:18px 0;padding:14px 16px;background:#f5f7fa;border-left:3px solid #10b981;border-radius:4px;">
        <div style="font-size:11px;font-weight:700;color:#475569;letter-spacing:0.06em;text-transform:uppercase;margin-bottom:6px;">${titulo}</div>
        ${conteudo}
      </div>`;

    const html = `
      <div style="font-family:system-ui,-apple-system,Segoe UI,Arial,sans-serif;color:#0f172a;max-width:560px;margin:0 auto;padding:24px 16px;">
        <p style="font-size:15px;">${empresaNome ? `Olá <b>${empresaNome}</b>,` : "Olá,"}</p>
        <p style="font-size:14px;color:#475569;">Segue sua cobrança Medwork${numeroVenda ? ` referente à Venda Nº <b>${numeroVenda}</b>` : ""}.</p>
        ${valor || dataVencimento ? `
          <div style="display:flex;gap:24px;margin:18px 0;font-size:14px;">
            ${valor ? `<div><div style="color:#94a3b8;font-size:11px;text-transform:uppercase;letter-spacing:0.06em;">Valor</div><div style="font-size:18px;font-weight:700;color:#10b981;">${fmtMoney(valor)}</div></div>` : ""}
            ${dataVencimento ? `<div><div style="color:#94a3b8;font-size:11px;text-transform:uppercase;letter-spacing:0.06em;">Vencimento</div><div style="font-size:16px;font-weight:600;">${fmtDate(dataVencimento)}</div></div>` : ""}
          </div>` : ""}
        ${linkFaturaCA ? blocoHtml("Fatura (boleto + nota fiscal)", `
          <p style="margin:0 0 6px;"><a href="${linkFaturaCA}" target="_blank" rel="noreferrer" style="color:#10b981;font-weight:600;font-size:14px;">→ Acessar fatura completa</a></p>
          <p style="margin:0;font-size:12px;color:#64748b;">Inclui boleto, linha digitável e nota fiscal de serviço.</p>
        `) : ""}
        ${!linkFaturaCA && linkBoleto ? blocoHtml("Boleto bancário", `
          <p style="margin:0 0 6px;"><a href="${linkBoleto}" target="_blank" rel="noreferrer" style="color:#10b981;font-weight:600;">→ Acessar boleto</a></p>
          ${linhaDigitavel ? `<p style="margin:0;font-family:monospace;font-size:12px;background:#fff;padding:8px;border-radius:3px;word-break:break-all;">${linhaDigitavel}</p>` : ""}
        `) : ""}
        ${!linkFaturaCA && linkNf ? blocoHtml(`Nota fiscal${numeroNf ? ` Nº ${numeroNf}` : ""}`, `
          <p style="margin:0;"><a href="${linkNf}" target="_blank" rel="noreferrer" style="color:#10b981;font-weight:600;">→ Visualizar nota fiscal</a></p>
        `) : ""}
        ${linkEso ? blocoHtml("Relatório ESO", `
          <p style="margin:0;"><a href="${linkEso}" target="_blank" rel="noreferrer" style="color:#10b981;font-weight:600;">→ Acessar relatório</a></p>
        `) : ""}
        <p style="font-size:13px;color:#64748b;margin-top:24px;">Qualquer dúvida estamos à disposição.</p>
        <p style="font-size:13px;color:#0f172a;font-weight:600;">— Medwork</p>
      </div>
    `;

    const info = await t.sendMail({
      from: `"Medwork" <${fromUser}>`,
      to: destinatarios.join(", "),
      cc: cc.length > 0 ? cc.join(", ") : undefined,
      subject,
      text,
      html,
    });

    return res.status(200).json({
      ok: true,
      messageId: info.messageId,
      accepted: info.accepted,
      rejected: info.rejected,
    });
  } catch (e: any) {
    const msg = e?.message || String(e);
    // Gmail responde 454 / 421 quando atinge o limite diário. Reportamos
    // distinto pra o frontend decidir se enfileira pra outro dia.
    const isLimit = /quota|rate|limit|454|421|too many/i.test(msg);
    return res.status(isLimit ? 429 : 500).json({
      ok: false,
      error: msg,
      limit_atingido: isLimit,
    });
  }
}
