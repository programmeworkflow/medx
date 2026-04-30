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
  Object.entries(corsHeaders(req)).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const body: any = req.body || {};
    const destinatarios: string[] = Array.isArray(body.destinatarios)
      ? body.destinatarios.filter((e: string) => e && e.includes("@"))
      : [];
    const link = String(body.link || "").trim();
    const empresaNome = String(body.empresa_nome || "").trim();
    const numeroVenda = body.numero_venda ? String(body.numero_venda) : "";
    const cc: string[] = Array.isArray(body.cc)
      ? body.cc.filter((e: string) => e && e.includes("@"))
      : [];

    if (destinatarios.length === 0) {
      return res.status(400).json({ error: "destinatarios obrigatório (array de emails)" });
    }
    if (!link) {
      return res.status(400).json({ error: "link obrigatório" });
    }

    const t = getTransporter();
    const fromUser = process.env.GMAIL_USER!;
    const subject = numeroVenda
      ? `Link da fatura — Venda Nº ${numeroVenda}`
      : `Link da fatura`;
    const text = [
      empresaNome ? `Olá ${empresaNome},` : "Olá,",
      "",
      "Segue o link para acessar a sua fatura:",
      link,
      "",
      "Qualquer dúvida estamos à disposição.",
      "",
      "— Medwork",
    ].join("\n");
    const html = `
      <p>${empresaNome ? `Olá <b>${empresaNome}</b>,` : "Olá,"}</p>
      <p>Segue o link para acessar a sua fatura:</p>
      <p><a href="${link}" target="_blank" rel="noreferrer">${link}</a></p>
      <p>Qualquer dúvida estamos à disposição.</p>
      <p>— Medwork</p>
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
