import type { VercelRequest, VercelResponse } from "@vercel/node";
import crypto from "node:crypto";
import { supaAdmin, corsHeaders } from "../esocial/_lib.js";
import {
  getAuthorizeUrl,
  exchangeCode,
  loadTokens,
  caApi,
  caBff,
  FRONT_URL,
  forceRefresh,
} from "./_ca.js";
import {
  caBffSession,
  saveBffCookies,
  loadBffCookies,
  cognitoLoginInteractive,
  cognitoRefresh,
  cognitoStatus,
  getValidIdToken,
} from "./_caCognito.js";

// Garante que a pessoa na Conta Azul tem endereço completo (exigido pra NFS-e
// pela maioria das prefeituras). Tenta puxar do registro local da empresa em
// `empresas` e, se faltar, completa com BrasilAPI usando o CNPJ.
// Cache em memória da lista completa do CA (3000+ pessoas).
// Indexa por documento (CNPJ/CPF só dígitos). TTL de 5 min por execução.
let _caPessoasCache: { map: Map<string, any>; loadedAt: number } | null = null;

async function carregarPessoasCAIndexadas(): Promise<Map<string, any>> {
  // Cache válido por 5 min — evita re-carregar entre chunks consecutivos
  if (_caPessoasCache && Date.now() - _caPessoasCache.loadedAt < 300_000) {
    return _caPessoasCache.map;
  }

  const PAGE = 100;
  // Página 1 pra saber total
  const r1 = await caApi("GET", `/v1/pessoas?tamanho_pagina=${PAGE}&pagina=1`);
  const items1: any[] = r1?.itens || r1?.items || [];
  const total: number = r1?.totalItems ?? items1.length;
  const totalPages = Math.ceil(total / PAGE);

  const allItems: any[] = [...items1];
  // Páginas 2..N em paralelo (lotes de 5)
  for (let start = 2; start <= totalPages; start += 5) {
    const batch = Array.from({ length: Math.min(5, totalPages - start + 1) }, (_, i) => {
      const qs = new URLSearchParams({ tamanho_pagina: String(PAGE), pagina: String(start + i) });
      return caApi("GET", `/v1/pessoas?${qs}`).then((r: any) => r?.items || r?.itens || []).catch(() => []);
    });
    const pages = await Promise.all(batch);
    pages.forEach((p: any[]) => allItems.push(...p));
  }

  const map = new Map<string, any>();
  for (const p of allItems) {
    const doc = String(p?.documento || "").replace(/\D/g, "");
    if (doc) map.set(doc, p);
  }
  _caPessoasCache = { map, loadedAt: Date.now() };
  return map;
}

// Consulta dados de CNPJ na Receita Federal. Tenta múltiplas fontes
// porque APIs gratuitas costumam bloquear IPs de cloud providers.
async function buscarBrasilAPI(cnpj: string): Promise<{
  optante_simples: boolean | null;
  optante_mei: boolean | null;
  porte: string | null;
  situacao: string | null;
  found: boolean;
} | null> {
  if (cnpj.length !== 14) return null;

  const headers = {
    "User-Agent": "MedX-Medwork/1.0 (contato@medworkto.com)",
    "Accept": "application/json",
  };

  // Tentativa 1: BrasilAPI
  try {
    const r = await fetch(`https://brasilapi.com.br/api/cnpj/v1/${cnpj}`, {
      headers,
      signal: AbortSignal.timeout(8000),
    });
    if (r.status === 404) {
      return { optante_simples: null, optante_mei: null, porte: null, situacao: null, found: false };
    }
    if (r.ok) {
      const j: any = await r.json();
      return {
        optante_simples: j?.opcao_pelo_simples === true,
        optante_mei: j?.opcao_pelo_mei === true,
        porte: j?.porte || null,
        situacao: j?.descricao_situacao_cadastral || null,
        found: true,
      };
    }
  } catch {}

  // Tentativa 2: cnpj.ws (similar, mesmos dados, IP-friendly)
  try {
    const r = await fetch(`https://publica.cnpj.ws/cnpj/${cnpj}`, {
      headers,
      signal: AbortSignal.timeout(8000),
    });
    if (r.status === 404) {
      return { optante_simples: null, optante_mei: null, porte: null, situacao: null, found: false };
    }
    if (r.ok) {
      const j: any = await r.json();
      return {
        optante_simples: j?.simples?.simples === "Sim",
        optante_mei: j?.simples?.mei === "Sim",
        porte: j?.porte?.descricao || null,
        situacao: j?.estabelecimento?.situacao_cadastral || null,
        found: true,
      };
    }
  } catch {}

  // Tentativa 3: ReceitaWS (último recurso)
  try {
    const r = await fetch(`https://receitaws.com.br/v1/cnpj/${cnpj}`, {
      headers,
      signal: AbortSignal.timeout(10000),
    });
    if (r.ok) {
      const j: any = await r.json();
      if (j?.status === "ERROR") return null;
      const opcaoSimples = String(j?.opcao_pelo_simples || "").toUpperCase();
      const opcaoMei = String(j?.opcao_pelo_mei || "").toUpperCase();
      return {
        optante_simples: opcaoSimples === "SIM" || opcaoSimples === "TRUE",
        optante_mei: opcaoMei === "SIM" || opcaoMei === "TRUE",
        porte: j?.porte || null,
        situacao: j?.situacao || null,
        found: true,
      };
    }
  } catch {}

  return null;
}

// Resolve retenção tributária cruzando CA (orgão público) + BrasilAPI (regime real).
async function buscarRetencaoCompleta(
  cnpjOrCpf: string,
  caPessoa: any | null
): Promise<{
  retem_iss: boolean | null;
  retem_ir: boolean;
  retem_inss: boolean;
  retem_pis_cofins_csll: boolean;
  regime_tributario: string | null;
  optante_simples: boolean | null;
  orgao_publico: boolean;
  fonte: string;
}> {
  const digits = cnpjOrCpf.replace(/\D/g, "");
  const isPF = digits.length === 11;

  // 1. BrasilAPI (fonte de regime real) — só pra PJ
  let optanteSimples: boolean | null = null;
  let optanteMei = false;
  let braFonte = false;
  if (!isPF) {
    const bra = await buscarBrasilAPI(digits);
    if (bra?.found) {
      optanteSimples = bra.optante_simples;
      optanteMei = bra.optante_mei === true;
      braFonte = true;
    }
  }

  // 2. CA detalhe (pra orgao_publico — BrasilAPI não tem isso)
  let orgaoPub = false;
  let caFonte = false;
  if (caPessoa?.id) {
    try {
      const detalhes = await caApi("GET", `/v1/pessoas/${caPessoa.id}`);
      orgaoPub = detalhes?.orgao_publico === true;
      caFonte = true;
      // Fallback: se BrasilAPI não respondeu, usa CA (menos confiável)
      if (optanteSimples === null && !braFonte) {
        optanteSimples = detalhes?.optante_simples_nacional === true ? true : null;
      }
    } catch {}
  }

  // 3. Heurística de retenção
  let remIss = false, remIr = false, remInss = false, remPisCofins = false;
  let regime: string;
  if (orgaoPub) {
    regime = "orgao_publico";
    remIss = true; remIr = true; remInss = true; remPisCofins = true;
  } else if (isPF) {
    regime = "pessoa_fisica";
    remIss = false;
  } else if (optanteMei) {
    regime = "mei";
    remIss = false;
  } else if (optanteSimples === true) {
    regime = "simples";
    remIss = false;
  } else if (optanteSimples === false) {
    regime = "lucro_presumido_ou_real";
    remIss = true;
  } else {
    // BrasilAPI não respondeu e CA não tinha dado → indefinido
    regime = "indefinido";
  }

  // Fonte (auditoria)
  let fonte: string;
  if (braFonte && caFonte) fonte = "brasilapi+ca";
  else if (braFonte) fonte = "brasilapi";
  else if (caFonte) fonte = "ca";
  else fonte = "nao_encontrado";

  return {
    retem_iss: regime === "indefinido" ? null : remIss,
    retem_ir: remIr,
    retem_inss: remInss,
    retem_pis_cofins_csll: remPisCofins,
    regime_tributario: regime,
    optante_simples: optanteSimples,
    orgao_publico: orgaoPub,
    fonte,
  };
}

async function garantirEnderecoPessoa(personId: string, cnpj: string) {
  const pessoa = await caApi("GET", `/v1/pessoas/${personId}`);
  const enderecoOk = (e: any) =>
    e?.cep && e?.logradouro && e?.numero && e?.bairro && e?.cidade && e?.estado;
  if ((pessoa?.enderecos || []).some(enderecoOk)) return { ok: true, fonte: "ca" };

  // 1. Tenta MedX
  const sb = supaAdmin();
  const { data: empresa } = await sb
    .from("empresas")
    .select("*")
    .eq("cnpj", cnpj)
    .maybeSingle();

  let endereco: any = null;
  if (empresa?.cep && empresa?.logradouro && empresa?.numero) {
    endereco = {
      cep: String(empresa.cep).replace(/\D/g, ""),
      logradouro: empresa.logradouro,
      numero: String(empresa.numero || "S/N"),
      complemento: empresa.complemento || "",
      bairro: empresa.bairro || "",
      cidade: empresa.cidade || "",
      estado: empresa.uf || empresa.estado || "",
      pais: "Brasil",
    };
  }

  // 2. Fallback: BrasilAPI
  if (!endereco) {
    try {
      const r = await fetch(`https://brasilapi.com.br/api/cnpj/v1/${cnpj}`);
      if (r.ok) {
        const d: any = await r.json();
        endereco = {
          cep: String(d.cep || "").replace(/\D/g, ""),
          logradouro: d.logradouro || "",
          numero: String(d.numero || "S/N"),
          complemento: d.complemento || "",
          bairro: d.bairro || "",
          cidade: d.municipio || "",
          estado: d.uf || "",
          pais: "Brasil",
        };
      }
    } catch (_) {}
  }

  if (!endereco?.cep || !endereco?.logradouro || !endereco?.cidade || !endereco?.estado) {
    throw new Error(
      `Endereço incompleto pra CNPJ ${cnpj} — preencha em Cadastros → Empresas (CEP, logradouro, número, bairro, cidade, UF)`
    );
  }

  await caApi("PATCH", `/v1/pessoas/${personId}`, { enderecos: [endereco] });
  return { ok: true, fonte: empresa ? "medx" : "brasilapi", endereco };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  Object.entries(corsHeaders).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === "OPTIONS") return res.status(204).end();

  const action = String(req.query.action || "").toLowerCase();

  try {
    if (action === "authorize") {
      const state = crypto.randomBytes(16).toString("hex");
      return res.status(200).json({ url: getAuthorizeUrl(state), state });
    }

    if (action === "callback") {
      const code = (req.query.code as string) || "";
      const error = (req.query.error as string) || "";
      // Redireciona pro Vite SPA do mesmo host onde o callback rodou (rota
      // /faturamento existe lá). Evita 404 quando FRONT_URL aponta pro
      // medx-contratos (HTML monolítico com hash routing).
      const host = req.headers.host || "medx-flow-mocha.vercel.app";
      const proto = (req.headers["x-forwarded-proto"] as string) || "https";
      const baseReturn = `${proto}://${host}/faturamento`;
      if (error) return res.redirect(302, `${baseReturn}?ca_error=${encodeURIComponent(error)}`);
      if (!code) return res.status(400).send("Faltou parâmetro code");
      try {
        await exchangeCode(code);
        return res.redirect(302, `${baseReturn}?ca_connected=1`);
      } catch (err: any) {
        return res.redirect(302, `${baseReturn}?ca_error=${encodeURIComponent(err?.message || "callback failed")}`);
      }
    }

    if (action === "status") {
      const t = await loadTokens();
      if (!t) return res.status(200).json({ connected: false });
      const expMs = new Date(t.expires_at).getTime() - Date.now();
      return res.status(200).json({
        connected: true,
        expires_at: t.expires_at,
        expires_in_seconds: Math.floor(expMs / 1000),
      });
    }

    if (action === "disconnect") {
      if (req.method !== "POST" && req.method !== "DELETE")
        return res.status(405).json({ error: "Method not allowed" });
      const sb = supaAdmin();
      await sb.from("contaazul_tokens").delete().eq("id", 1);
      return res.status(200).json({ ok: true });
    }

    if (action === "send-email-venda") {
      // Replica o "Enviar e-mail" da UI da CA. Body:
      //   { vendaId, emails?, cc?, mensagem_extra?, senderEmail?, senderName?, viewOptions? }
      // Se emails não vier, busca defaults do billingContact da venda.
      // cc vai concatenado em customerMail (CA não tem campo cc separado no payload BFF;
      // ambos vão como destinatários).
      // mensagem_extra é injetado em viewOptions.message ou customMessage.
      if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
      const body: any = req.body || {};
      const vendaId = body.vendaId as string;
      if (!vendaId) return res.status(400).json({ error: "vendaId obrigatório" });

      // 1. Busca info da venda pra pegar customerId (registryId)
      const info = await caBffSession(
        "GET",
        `https://services.contaazul.com/contaazul-bff/sale/v1/sales/${vendaId}`
      );
      if (!info.ok) {
        return res.status(500).json({ error: `lookup venda falhou: ${info.status}` });
      }
      // CA usa "negotiatorId" como ID do cliente da venda. Caminhos alternativos
      // pra robustez se a estrutura mudar.
      const customerId =
        info.data?.negotiatorId ||
        info.data?.negotiator?.uuid ||
        info.data?.customer?.id ||
        info.data?.customerId ||
        info.data?.financialEvent?.paymentCondition?.installments?.[0]?.chargeRequests?.[0]?.customerId;
      if (!customerId) {
        return res.status(500).json({ error: "customerId/negotiatorId não encontrado na venda" });
      }

      // 2. Resolve emails: se body.emails veio, usa. Senão pega do
      //    negotiator.billingContact direto na venda (já vem no GET de cima).
      //    Fallback: chama /billing/contact se ainda não tiver.
      let emails: string[] = Array.isArray(body.emails) ? body.emails.filter(Boolean) : [];
      if (emails.length === 0) {
        const bcInline =
          info.data?.negotiator?.billingContact?.emails ||
          info.data?.negotiator?.emails ||
          [];
        emails = (bcInline as string[]).filter(Boolean);
      }
      if (emails.length === 0) {
        const bc = await caBffSession(
          "GET",
          `https://services.contaazul.com/billing/contact?customerId=${customerId}`
        );
        if (bc.ok) {
          const bcEmails = bc.data?.billingContact?.emails || bc.data?.emails || [];
          emails = bcEmails.filter(Boolean);
        }
      }
      // Se ainda não tem, usa o email do próprio negotiator
      if (emails.length === 0 && info.data?.negotiator?.email) {
        emails = [info.data.negotiator.email];
      }
      if (emails.length === 0) {
        return res.status(400).json({ error: "Sem emails de destinatário (billingContact vazio)" });
      }
      const cc: string[] = Array.isArray(body.cc) ? body.cc.filter(Boolean) : [];
      const todos = [...new Set([...emails, ...cc])];

      // dry_run: só retorna os emails encontrados, não envia
      if (req.query.dry_run === "1") {
        return res.status(200).json({ ok: true, emails, customerId, dry_run: true });
      }

      // 3. Monta title + content (campos certos vão DENTRO de viewOptions).
      //    CA usa HTML simples no content (com <br> pra quebra de linha).
      const numero = info.data?.number ?? info.data?.numero ?? "";
      const ownerName = info.data?.owner?.name?.trim() || "Medwork";
      const clienteNome =
        info.data?.negotiator?.name ||
        info.data?.negotiator?.companyName ||
        "Cliente";
      const valorNet =
        info.data?.valueComposition?.netValue ??
        info.data?.financialEvent?.paymentCondition?.installments?.[0]?.valueComposition?.netValue ??
        info.data?.value ??
        0;
      const valorFmt = Number(valorNet).toLocaleString("pt-BR", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
      const title =
        body.subject ||
        body.title ||
        `[Importante] A fatura Nº ${numero} de ${ownerName} está disponível`;
      let content =
        body.content ||
        `Olá ${clienteNome},<br>A Fatura Nº ${numero} no valor de R$ ${valorFmt} está disponível.`;
      // CA bloqueia URLs no body por anti-phishing. Se mensagem_extra tiver
      // URL, remove pra evitar 400. O link fica disponível na cópia que vai
      // pro senderEmail (Medwork) via sendEmailCopy=true — a empresa
      // responde o e-mail com o link.
      let urlsRemovidas: string[] = [];
      if (body.mensagem_extra) {
        let extraHtml = String(body.mensagem_extra).replace(/\n/g, "<br>");
        const urlRegex = /\bhttps?:\/\/\S+|\b[a-z0-9-]+\.(com|com\.br|net|org|app|io)(\/\S*)?/gi;
        const matches = extraHtml.match(urlRegex) || [];
        if (matches.length > 0) {
          urlsRemovidas = matches;
          extraHtml = extraHtml.replace(urlRegex, "[link enviado em separado]");
        }
        content += `<br><br>${extraHtml}`;
      }
      const senderEmail =
        body.senderEmail ||
        process.env.CONTA_AZUL_SENDER_EMAIL ||
        "medwork.financeiro@gmail.com";
      // CA usa o nome do cliente em senderName (visto no payload da UI)
      const senderName = body.senderName || clienteNome;
      // sendEmailCopy=true manda cópia pro senderEmail automaticamente
      const sendEmailCopy = body.send_copy_to_sender !== false;

      // 4. POST do envio com a estrutura correta descoberta via DevTools
      const payload = {
        customerMail: todos.join(","),
        notificationReference: vendaId,
        registryId: customerId,
        senderEmail,
        senderName,
        viewOptions: {
          ...(body.viewOptions || {}),
          title,
          content,
          sendEmailCopy,
        },
      };
      const r = await caBffSession(
        "POST",
        `https://services.contaazul.com/billing-notifier/invoice/send-to/${vendaId}`,
        payload
      );
      if (!r.ok) {
        return res.status(r.status >= 400 ? r.status : 500).json({
          ok: false,
          error: `envio falhou: ${r.status} ${r.text?.slice(0, 200)}`,
        });
      }
      return res.status(200).json({
        ok: true,
        emails: todos,
        urls_removidas: urlsRemovidas,
        response: r.data,
      });
    }

    if (action === "billing-contact-venda") {
      // GET ?vendaId=... → retorna { emails: [...], customerName: "..." }
      const vendaId = (req.query.vendaId as string) || "";
      if (!vendaId) return res.status(400).json({ error: "vendaId obrigatório" });
      const info = await caBffSession(
        "GET",
        `https://services.contaazul.com/contaazul-bff/sale/v1/sales/${vendaId}`
      );
      if (!info.ok) return res.status(500).json({ error: "lookup venda falhou" });
      const customerId =
        info.data?.negotiatorId ||
        info.data?.negotiator?.uuid ||
        info.data?.customer?.id ||
        info.data?.customerId;
      const customerName =
        info.data?.negotiator?.name ||
        info.data?.negotiator?.companyName ||
        info.data?.customer?.name ||
        info.data?.customerName ||
        "";
      let emails: string[] = (
        info.data?.negotiator?.billingContact?.emails ||
        info.data?.negotiator?.emails ||
        []
      ).filter(Boolean);
      if (emails.length === 0 && customerId) {
        const bc = await caBffSession(
          "GET",
          `https://services.contaazul.com/billing/contact?customerId=${customerId}`
        );
        if (bc.ok) {
          emails = (bc.data?.billingContact?.emails || bc.data?.emails || []).filter(Boolean);
        }
      }
      if (emails.length === 0 && info.data?.negotiator?.email) {
        emails = [info.data.negotiator.email];
      }
      return res.status(200).json({ emails, customerName, customerId });
    }

    if (action === "debug-vendas-recentes") {
      const sb = supaAdmin();
      const { data } = await sb
        .from("contaazul_vendas")
        .select("ca_venda_id,cnpj,raw,nf_status,boleto_status,created_at")
        .order("created_at", { ascending: false })
        .limit(5);
      const itens = (data || []).map((v: any) => ({
        ca_venda_id: v.ca_venda_id,
        numero: v.raw?.venda?.numero,
        cnpj: v.cnpj,
        nf_status: v.nf_status,
        boleto_status: v.boleto_status,
        created_at: v.created_at,
      }));
      return res.status(200).json({ itens });
    }

    if (action === "debug-faturamentos") {
      // Debug temporário: lista faturamentos por competência (mes/ano).
      // Usa service role, ignora RLS. Remover após debug.
      const mes = Number((req.query.mes as string) || "0");
      const ano = Number((req.query.ano as string) || "0");
      if (!mes || !ano) return res.status(400).json({ error: "mes e ano obrigatórios" });
      const sb = supaAdmin();
      const { data: comps } = await sb
        .from("competencias")
        .select("id,mes,ano,status,criado_em")
        .eq("mes", mes)
        .eq("ano", ano);
      const compIds = (comps || []).map((c: any) => c.id);
      let fats: any[] = [];
      if (compIds.length > 0) {
        const r = await sb
          .from("faturamentos")
          .select("id,competencia_id,status,valor,categoria_snapshot,empresa_executora_id,criado_em")
          .in("competencia_id", compIds)
          .order("criado_em", { ascending: false })
          .limit(20);
        fats = r.data || [];
      }
      const { count: totalFats } = compIds.length
        ? await sb
            .from("faturamentos")
            .select("id", { count: "exact", head: true })
            .in("competencia_id", compIds)
        : { count: 0 };
      return res.status(200).json({
        competencias: comps || [],
        total_faturamentos_na_competencia: totalFats,
        amostra: fats,
      });
    }

    if (action === "oauth-refresh") {
      // Cron diário (3h UTC) e endpoint manual: força refresh do OAuth2
      // pra manter o refresh_token vivo (cada uso renova a janela CA de 30d)
      const result = await forceRefresh();
      return res.status(result.ok ? 200 : 500).json(result);
    }

    if (action === "health-check") {
      // Cron semanal — testa todos os componentes da integração CA.
      // Logs aparecem em Vercel → Functions logs. Status 500 sinaliza falha.
      const checks: Record<string, any> = {};
      let healthy = true;

      try {
        const t = await loadTokens();
        const expIn = t ? Math.floor((new Date(t.expires_at).getTime() - Date.now()) / 1000) : null;
        checks.oauth_token = {
          ok: !!t && (expIn ?? 0) > 0,
          expires_in_seconds: expIn,
          expires_at: t?.expires_at,
        };
        if (!checks.oauth_token.ok) healthy = false;
      } catch (e: any) {
        checks.oauth_token = { ok: false, error: e?.message };
        healthy = false;
      }

      try {
        const r = await caApi("GET", "/v1/servicos?perPage=1");
        const items = r?.itens || r?.items || [];
        checks.oauth_call = { ok: items.length > 0, items_count: items.length };
        if (!checks.oauth_call.ok) healthy = false;
      } catch (e: any) {
        checks.oauth_call = { ok: false, error: e?.message?.slice(0, 200) };
        healthy = false;
      }

      try {
        const cog = await cognitoStatus();
        checks.cognito = {
          ok: !!cog?.connected,
          email: cog?.email,
          expires_in_seconds: cog?.access_token_expires_in_seconds,
        };
        if (!checks.cognito.ok) healthy = false;
      } catch (e: any) {
        checks.cognito = { ok: false, error: e?.message };
        healthy = false;
      }

      const summary = {
        healthy,
        checked_at: new Date().toISOString(),
        checks,
      };
      console.log(`[CA HEALTH-CHECK] ${healthy ? "OK" : "DEGRADED"}`, JSON.stringify(summary));
      return res.status(healthy ? 200 : 500).json(summary);
    }

    if (action === "cost-centers") {
      // Lista centros de custo com filtro opcional ?busca=
      const busca = (req.query.busca as string) || "";
      const r = await caApi(
        "GET",
        busca ? `/v1/centro-de-custo?busca=${encodeURIComponent(busca)}` : "/v1/centro-de-custo?perPage=100"
      );
      return res.status(200).json({
        items: (r?.itens || []).map((c: any) => ({ id: c.id, nome: c.nome })),
      });
    }

    if (action === "financial-categories") {
      // Lista categorias financeiras (RECEITA por default — pra venda).
      // ?tipo=DESPESA pra despesa.
      const tipo = (req.query.tipo as string) || "RECEITA";
      const accumulated: any[] = [];
      for (let pagina = 1; pagina <= 10; pagina++) {
        const r = await caApi(
          "GET",
          `/v1/categorias?tipo=${tipo}&pagina=${pagina}&tamanho_pagina=100`
        );
        const items = r?.itens || r?.items || r?.content || (Array.isArray(r) ? r : []);
        if (!items.length) break;
        accumulated.push(...items);
        if (items.length < 100) break;
      }
      return res.status(200).json({
        items: accumulated
          .map((c: any) => ({ id: c.id || c.uuid, nome: c.nome || c.descricao, tipo: c.tipo }))
          .sort((a: any, b: any) => (a.nome || "").localeCompare(b.nome || "")),
      });
    }

    if (action === "buscar-retencao") {
      // Single CNPJ — usado no cadastro novo de empresa
      const cnpj = String(req.query.cnpj || "").replace(/\D/g, "");
      if (!cnpj || (cnpj.length !== 14 && cnpj.length !== 11)) {
        return res.status(400).json({ error: "cnpj/cpf inválido" });
      }
      // Tenta achar no CA pelo cache; mesmo se não achar, BrasilAPI já basta
      let pessoa: any = null;
      try {
        const map = await carregarPessoasCAIndexadas();
        pessoa = map.get(cnpj) || null;
      } catch {}
      const result = await buscarRetencaoCompleta(cnpj, pessoa);
      return res.status(200).json(result);
    }

    if (action === "sync-retencao") {
      // Batch: processa empresas do Supabase, busca no CA, atualiza retenção.
      // Carrega lista completa do CA uma vez (CA não tem busca por documento),
      // indexa por documento, e processa em chunks pra caber no timeout.
      const offset = Number(req.query.offset || 0);
      const limit = Math.min(Number(req.query.limit || 20), 50);
      const sb = supaAdmin();

      // 1. Carrega map { documento → ca_pessoa } UMA VEZ
      const map = await carregarPessoasCAIndexadas();

      // 2. Pega lote de empresas (PULA empresas com override manual)
      const { data: empresas, error } = await sb
        .from("empresas")
        .select("id, cnpj")
        .or("retencao_fonte.is.null,retencao_fonte.neq.manual")
        .order("retencao_atualizada_em", { ascending: true, nullsFirst: true })
        .range(offset, offset + limit - 1);
      if (error) return res.status(500).json({ error: error.message });

      const stats = { processadas: 0, encontradas_ca: 0, nao_encontradas: 0, erros: [] as any[] };

      // 3. Processa SEQUENCIALMENTE com delay (APIs grátis têm rate limit baixo)
      const tasks = (empresas || []).map((empresa: any) => async () => {
        try {
          const cnpjDigits = String(empresa.cnpj || "").replace(/\D/g, "");
          if (cnpjDigits.length !== 14 && cnpjDigits.length !== 11) return;

          const pessoa = map.get(cnpjDigits) || null;
          const ret = await buscarRetencaoCompleta(cnpjDigits, pessoa);

          await sb.from("empresas").update({
            retem_iss: ret.retem_iss,
            retem_ir: ret.retem_ir,
            retem_inss: ret.retem_inss,
            retem_pis_cofins_csll: ret.retem_pis_cofins_csll,
            regime_tributario: ret.regime_tributario,
            optante_simples: ret.optante_simples,
            orgao_publico: ret.orgao_publico,
            retencao_atualizada_em: new Date().toISOString(),
            retencao_fonte: ret.fonte,
          }).eq("id", empresa.id);

          stats.processadas++;
          if (ret.fonte.includes("brasilapi")) stats.encontradas_ca++;
          else stats.nao_encontradas++;
        } catch (err: any) {
          stats.erros.push({ cnpj: empresa.cnpj, erro: err?.message?.slice(0, 200) });
        }
      });

      // Roda 1 por vez com pausa (respeita rate limit das APIs)
      for (const task of tasks) {
        await task();
        await new Promise((r) => setTimeout(r, 250)); // 250ms entre cada empresa
      }

      const nextOffset = (empresas?.length || 0) === limit ? offset + limit : null;
      return res.status(200).json({
        ok: true, offset, limit, ...stats,
        ca_total_indexed: map.size,
        next_offset: nextOffset,
      });
    }

    if (action === "fornecedores") {
      // CA não filtra por perfis server-side. Paginamos tudo com tamanho_pagina=100
      // e filtramos client-side. Páginas paralelas após a 1ª para ser rápido.
      const busca = (req.query.busca as string) || "";
      const PAGE = 100;
      const qs1 = new URLSearchParams({ tamanho_pagina: String(PAGE), pagina: "1" });
      if (busca) qs1.set("busca", busca);
      const r1 = await caApi("GET", `/v1/pessoas?${qs1}`);
      const items1: any[] = r1?.items || r1?.itens || (Array.isArray(r1) ? r1 : []);
      const total: number = r1?.totalItems ?? items1.length;
      const totalPages = Math.ceil(total / PAGE);
      // Busca páginas 2..N em paralelo (lotes de 5 pra não sobrecarregar)
      const remaining: any[] = [];
      for (let start = 2; start <= totalPages; start += 5) {
        const batch = Array.from({ length: Math.min(5, totalPages - start + 1) }, (_, i) => {
          const qs = new URLSearchParams({ tamanho_pagina: String(PAGE), pagina: String(start + i) });
          if (busca) qs.set("busca", busca);
          return caApi("GET", `/v1/pessoas?${qs}`).then((r: any) => r?.items || r?.itens || []).catch(() => []);
        });
        const pages = await Promise.all(batch);
        pages.forEach((p: any[]) => remaining.push(...p));
      }
      const all = [...items1, ...remaining];
      const fornecedores = all
        .filter((f: any) => (f.perfis || []).some((p: string) => p.toLowerCase() === "fornecedor") && f.ativo !== false)
        .map((f: any) => ({
          id: f.id || f.uuid,
          nome: f.nome || f.razao_social || f.razaoSocial || f.name || "",
          documento: f.cpf_cnpj || f.cpfCnpj || f.cnpj || f.cpf || "",
        }))
        .sort((a: any, b: any) => a.nome.localeCompare(b.nome, "pt-BR"));
      return res.status(200).json({ items: fornecedores, total: fornecedores.length });
    }

    if (action === "contas-pagar") {
      // A API pública do CA não tem endpoint de contas-a-pagar.
      // Servimos as bills salvas no Supabase (criadas pelo nosso app).
      const sb = supaAdmin();
      const { data_de, data_ate, situacao } = req.query;
      let query = sb.from("contas_pagar").select("*").order("data_vencimento", { ascending: true });
      if (data_de) query = query.gte("data_vencimento", data_de as string);
      if (data_ate) query = query.lte("data_vencimento", data_ate as string);
      if (situacao) query = query.eq("situacao", situacao as string);
      const { data, error } = await query;
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({
        items: (data || []).map((r: any) => ({
          id: r.id,
          descricao: r.descricao,
          valor: r.valor,
          data_vencimento: r.data_vencimento,
          situacao: r.situacao,
          fornecedor: { nome: r.fornecedor_nome },
          ca_id: r.ca_id,
        })),
        total: data?.length ?? 0,
      });
    }

    if (action === "atualizar-conta-pagar") {
      if (req.method !== "PATCH" && req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
      const body: any = req.body || {};
      const { id, situacao } = body;
      if (!id) return res.status(400).json({ error: "id obrigatório" });
      const sb = supaAdmin();
      const updates: any = { updated_at: new Date().toISOString() };
      if (situacao) updates.situacao = situacao;
      if (situacao === "PAGO") updates.data_pagamento = new Date().toISOString().split("T")[0];
      const { error } = await sb.from("contas_pagar").update(updates).eq("id", id);
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ ok: true });
    }

    if (action === "criar-conta-pagar") {
      if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
      const body: any = req.body || {};
      const { fornecedor_id, descricao, valor, data_vencimento, parcelas, categoria_id, centro_custo_id } = body;
      if (!fornecedor_id || !descricao || !valor || !data_vencimento) {
        return res.status(400).json({ error: "fornecedor_id, descricao, valor e data_vencimento obrigatórios" });
      }
      const n = Math.max(1, Math.min(48, Math.floor(Number(parcelas) || 1)));
      const valorParcela = Math.round((Number(valor) / n) * 100) / 100;
      const results: any[] = [];
      const errors: any[] = [];
      // busca nome do fornecedor para salvar no Supabase
      let fornecedorNome = "";
      try {
        const pess = await caApi("GET", `/v1/pessoas/${fornecedor_id}`);
        fornecedorNome = pess?.nome || "";
      } catch {}
      const sb = supaAdmin();
      for (let i = 0; i < n; i++) {
        const dt = new Date(data_vencimento + "T12:00:00");
        dt.setMonth(dt.getMonth() + i);
        const dtStr = dt.toISOString().split("T")[0];
        const descParcela = n > 1 ? `${descricao} (${i + 1}/${n})` : descricao;
        const caPayload: any = {
          descricao: descParcela, valor: valorParcela, data_vencimento: dtStr,
          fornecedor: { id: fornecedor_id },
        };
        if (categoria_id) caPayload.categoria = { id: categoria_id };
        if (centro_custo_id) caPayload.centro_custo = { id: centro_custo_id };
        let caId: string | null = null;
        try {
          const r = await caApi("POST", "/v1/contas-a-pagar", caPayload);
          caId = r?.id || null;
          results.push(r);
        } catch (err: any) {
          // CA API pode não ter endpoint de contas-a-pagar — salva só no Supabase
          errors.push({ parcela: i + 1, error: err?.message?.slice(0, 200) });
        }
        // Salva sempre no Supabase como fonte de verdade local
        try {
          await sb.from("contas_pagar").insert({
            descricao: descParcela, valor: valorParcela, data_vencimento: dtStr,
            fornecedor_id, fornecedor_nome: fornecedorNome,
            categoria_id: categoria_id || null, centro_custo_id: centro_custo_id || null,
            situacao: "PENDENTE", ca_id: caId, created_at: new Date().toISOString(),
          });
        } catch {}
      }
      return res.status(200).json({ ok: true, criadas: n, erros: errors.length, errors });
    }

    if (action === "nome-amigavel-servico") {
      // Recebe { nome } e devolve { rotulo } — nome curto pra observação da NF.
      // 1) Tenta mapeamento regex (rápido, sem custo)
      // 2) Se ANTHROPIC_API_KEY, pede pra Claude resumir
      // 3) Fallback: nome limpo em minúsculo
      const body: any = req.body || {};
      const nome = String(body.nome || "");
      const limpo = nome.replace(/\s*\([^)]*\)\s*$/g, "").trim();
      const HARD: { match: RegExp; out: string }[] = [
        { match: /exame/i, out: "Exames" },
        { match: /treinamento/i, out: "Treinamentos" },
        { match: /pcmso/i, out: "PCMSO" },
        { match: /pgr/i, out: "PGR" },
        { match: /elabora.*documento/i, out: "Documentos" },
        { match: /gest.o.*sst/i, out: "Gestão de SST" },
        { match: /assessoria.*sst/i, out: "Assessoria de SST" },
        { match: /laudo/i, out: "Laudos" },
        { match: /avalia/i, out: "Avaliações" },
      ];
      const hit = HARD.find((r) => r.match.test(limpo));
      if (hit) return res.status(200).json({ rotulo: hit.out, fonte: "regex" });
      if (!process.env.ANTHROPIC_API_KEY) {
        return res.status(200).json({ rotulo: limpo, fonte: "fallback" });
      }
      try {
        const r = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "x-api-key": process.env.ANTHROPIC_API_KEY!,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: "claude-haiku-4-5-20251001",
            max_tokens: 30,
            messages: [
              {
                role: "user",
                content:
                  `Você recebe o nome técnico de um serviço de saúde ocupacional/SST e deve devolver um rótulo curto (1 a 3 palavras, capitalizado, em português) pra usar numa observação de nota fiscal. Devolva só o rótulo, sem aspas, sem explicação.\n\nNome técnico: ${limpo}`,
              },
            ],
          }),
        });
        const j: any = await r.json();
        const txt = (j?.content?.[0]?.text || "").trim();
        return res.status(200).json({ rotulo: txt || limpo, fonte: "ai" });
      } catch (_) {
        return res.status(200).json({ rotulo: limpo, fonte: "fallback" });
      }
    }

    if (action === "services") {
      // Lista todos os serviços cadastrados, paginando até esgotar.
      // Default: só ATIVOS (qualquer tipo_servico). ?all=1 traz inativos também.
      // ?prestado_only=1 filtra só PRESTADO.
      const all = req.query.all === "1";
      const prestadoOnly = req.query.prestado_only === "1";
      const accumulated: any[] = [];
      for (let pagina = 1; pagina <= 20; pagina++) {
        const r = await caApi("GET", `/v1/servicos?pagina=${pagina}&tamanho_pagina=100`);
        const items = r?.itens || r?.items || r?.content || [];
        if (!items.length) break;
        accumulated.push(...items);
        if (items.length < 100) break;
      }
      const filtered = accumulated.filter((s: any) => {
        if (!all && (s.status || "ATIVO") !== "ATIVO") return false;
        if (prestadoOnly && (s.tipo_servico || "PRESTADO") !== "PRESTADO") return false;
        return true;
      });
      return res.status(200).json({
        total_no_ca: accumulated.length,
        items: filtered
          .map((s: any) => ({
            id: s.id,
            nome: s.nome || s.descricao,
            tipo_servico: s.tipo_servico,
            status: s.status,
            valor: s.valor,
          }))
          .sort((a: any, b: any) => (a.nome || "").localeCompare(b.nome || "")),
      });
    }
    if (action === "bff") {
      // Testa endpoints internos BFF da UI Conta Azul (services.contaazul.com)
      // Usa Cognito SRP login (IdToken) — endpoints internos não aceitam o token do OAuth2 público
      const url = (req.query.url as string) || "";
      if (!url || !url.startsWith("https://services.contaazul.com/")) {
        return res.status(400).json({ error: "url=https://services.contaazul.com/... obrigatório" });
      }
      const method = (req.query.method as string)?.toUpperCase() || (req.method === "GET" ? "GET" : "POST");
      const useOauth = req.query.use_oauth === "1";
      const useIdToken = req.query.use_id_token === "1";
      if (useIdToken) {
        const idToken = await getValidIdToken();
        const r = await fetch(url, {
          method,
          headers: { Authorization: `Bearer ${idToken}`, "Content-Type": "application/json", Accept: "application/json", Origin: "https://pro.contaazul.com", Referer: "https://pro.contaazul.com/" },
          body: method !== "GET" && req.body ? JSON.stringify(req.body) : undefined,
        });
        const text = await r.text();
        let json: any = null; try { json = JSON.parse(text); } catch {}
        return res.status(200).json({ ok: r.ok, status: r.status, data: json, text: text.slice(0, 1500) });
      }
      const fn = useOauth ? caBff : caBffSession;
      const r = await fn(method, url, method === "GET" ? undefined : req.body);
      return res.status(200).json(r);
    }

    if (action === "set-bff-cookies") {
      // Salva os 3 cookies BFF copiados do navegador (DevTools > Network > qualquer
      // request pra services.contaazul.com > Cabeçalhos > cookie). Aceita:
      //   { x_ca_auth, x_ca_device_key, x_ca_session_id }   (preferido)
      //   { cookie_header }   (cola o cookie inteiro do header e a gente extrai)
      if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
      const body = (req.body || {}) as any;
      let xCaAuth = body.x_ca_auth as string | undefined;
      let xCaDevice = body.x_ca_device_key as string | undefined;
      let xCaSession = body.x_ca_session_id as string | undefined;
      if (body.cookie_header && typeof body.cookie_header === "string") {
        const get = (k: string) => {
          const m = body.cookie_header.match(new RegExp(`(?:^|;\\s*)${k}=([^;]+)`));
          return m ? m[1].trim() : undefined;
        };
        xCaAuth = xCaAuth || get("x-ca-auth");
        xCaDevice = xCaDevice || get("x-ca-device-key");
        xCaSession = xCaSession || get("x-ca-session-id");
      }
      if (!xCaAuth || !xCaDevice || !xCaSession) {
        return res.status(400).json({
          error: "x_ca_auth, x_ca_device_key e x_ca_session_id são obrigatórios",
        });
      }
      await saveBffCookies({
        x_ca_auth: xCaAuth,
        x_ca_device_key: xCaDevice,
        x_ca_session_id: xCaSession,
      });
      const c = await loadBffCookies();
      return res.status(200).json({
        ok: true,
        expires_at: c?.expires_at,
        x_ca_auth_preview: xCaAuth.slice(0, 30) + "..." + xCaAuth.slice(-10),
      });
    }

    if (action === "bff-status") {
      const c = await loadBffCookies();
      if (!c) return res.status(200).json({ ok: false, configured: false });
      const expMs = new Date(c.expires_at).getTime() - Date.now();
      return res.status(200).json({
        ok: true,
        configured: true,
        expires_at: c.expires_at,
        expires_in_seconds: Math.floor(expMs / 1000),
        expired: expMs < 0,
      });
    }

    if (action === "debug-brasilapi") {
      const cnpj = String(req.query.cnpj || "42643059000148").replace(/\D/g, "");
      const t0 = Date.now();
      try {
        const r = await fetch(`https://brasilapi.com.br/api/cnpj/v1/${cnpj}`, {
          signal: AbortSignal.timeout(15000),
        });
        const text = await r.text();
        let json: any = null;
        try { json = JSON.parse(text); } catch {}
        return res.status(200).json({
          ok: r.ok,
          status: r.status,
          ms: Date.now() - t0,
          opcao_pelo_simples: json?.opcao_pelo_simples,
          opcao_pelo_mei: json?.opcao_pelo_mei,
          razao_social: json?.razao_social,
          raw_text: text.slice(0, 300),
        });
      } catch (err: any) {
        return res.status(200).json({
          ok: false,
          ms: Date.now() - t0,
          error: err?.message || String(err),
          name: err?.name,
        });
      }
    }

    if (action === "reset-retencao") {
      // Reseta retencao_atualizada_em → todas voltam pra fila do sync.
      // Use ?apenas_indefinidas=1 pra resetar SÓ as que ficaram em indefinido
      // (preserva as que já estão corretas).
      const sb = supaAdmin();
      const apenasIndefinidas = req.query.apenas_indefinidas === "1";
      let q = sb.from("empresas").update({ retencao_atualizada_em: null }, { count: "exact" });
      if (apenasIndefinidas) {
        q = q.or("regime_tributario.eq.indefinido,regime_tributario.is.null");
      } else {
        q = q.not("id", "is", null);
      }
      // Sempre preserva overrides manuais
      q = q.or("retencao_fonte.is.null,retencao_fonte.neq.manual");
      const { error, count } = await q;
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ ok: true, resetadas: count, apenas_indefinidas: apenasIndefinidas });
    }

    if (action === "nf-debug-issue") {
      // Faz issue mas NÃO transmite — pra debug do PATCH com retenções
      const venda_id = String(req.query.venda_id || "");
      if (!venda_id) return res.status(400).json({ error: "venda_id obrigatório" });
      const info = await caBffSession("GET", `https://services.contaazul.com/contaazul-bff/sale/v1/sales/${venda_id}`);
      const legacyId = info.data?.legacyId;
      if (!legacyId) return res.status(400).json({ error: "legacyId não encontrado" });
      const issue = await caBffSession("POST", `https://services.contaazul.com/app/serviceinvoice/v2/issue/sale/${legacyId}`, {});
      const nfLegacy = issue.data?.data || issue.data?.id;
      if (!nfLegacy) return res.status(500).json({ error: "issue falhou", text: issue.text });
      // Pega detalhe da NF rascunho
      const detalhe = await caBffSession("GET", `https://services.contaazul.com/app/serviceinvoice/v2/${nfLegacy}`);
      return res.status(200).json({ ok: true, nf_legacy: nfLegacy, detalhe: detalhe.data });
    }

    if (action === "nf-debug-patch") {
      // Tenta PATCH/PUT numa NF rascunho com retenções federais
      const nfLegacy = String(req.query.nf_legacy || "");
      const transmit = req.query.transmit === "1";
      if (!nfLegacy) return res.status(400).json({ error: "nf_legacy obrigatório" });
      const method = (req.query.m as string) || "PUT";
      const body = req.body || {};
      const r = await caBffSession(method, `https://services.contaazul.com/app/serviceinvoice/v2/${nfLegacy}`, body);
      if (transmit && r.ok) {
        const t = await caBffSession("PUT", `https://services.contaazul.com/app/serviceinvoice/v2/${nfLegacy}/transmit`, {});
        return res.status(200).json({ patch: r, transmit: t });
      }
      return res.status(200).json(r);
    }

    if (action === "debug-empresa") {
      // Diagnóstico: mostra se a empresa local tem retem_iss
      const cnpj = String(req.query.cnpj || "").replace(/\D/g, "");
      if (!cnpj) return res.status(400).json({ error: "cnpj obrigatório" });
      const sb = supaAdmin();
      // Tenta vários formatos
      const { data: e1 } = await sb.from("empresas").select("*").eq("cnpj", cnpj).maybeSingle();
      const { data: e2 } = await sb.from("empresas").select("*").ilike("cnpj", `%${cnpj}%`).limit(5);
      // Match por raw cnpj
      const { data: todas } = await sb.from("empresas").select("id, nome_empresa, cnpj, retem_iss, regime_tributario");
      const matching = (todas || []).filter((e: any) => String(e.cnpj || "").replace(/\D/g, "") === cnpj);
      return res.status(200).json({
        cnpj_buscado: cnpj,
        match_eq_exato: e1,
        match_ilike: e2,
        match_normalizado: matching,
      });
    }

    if (action === "marcar-erros-ja-faturados") {
      // Marca como "concluido" os faturamentos com ca_error que já têm
      // venda no CA com mesmo CNPJ + mesmo valor.
      const sb = supaAdmin();
      const { data: erros } = await sb.from("faturamentos").select("*").eq("status", "ca_error");
      const empIds = Array.from(new Set((erros || []).map((e: any) => e.empresa_executora_id).filter(Boolean)));
      const { data: empresas } = await sb.from("empresas").select("id, cnpj").in("id", empIds);
      const empById = new Map((empresas || []).map((e: any) => [e.id, e]));
      const { data: vendasCA } = await sb
        .from("contaazul_vendas")
        .select("cnpj, valor, ca_venda_id");
      const vendasPorCnpj = new Map<string, any[]>();
      for (const v of vendasCA || []) {
        const k = String(v.cnpj || "").replace(/\D/g, "");
        if (!vendasPorCnpj.has(k)) vendasPorCnpj.set(k, []);
        vendasPorCnpj.get(k)!.push(v);
      }
      let atualizados = 0;
      for (const f of erros || []) {
        const cnpj = String((f.cnpj_snapshot || empById.get(f.empresa_executora_id)?.cnpj || "")).replace(/\D/g, "");
        const vendas = vendasPorCnpj.get(cnpj) || [];
        const match = vendas.some((v: any) => Math.abs(Number(v.valor || 0) - Number(f.valor || 0)) < 0.01);
        if (match) {
          await sb.from("faturamentos").update({ status: "concluido" }).eq("id", f.id);
          atualizados++;
        }
      }
      return res.status(200).json({ ok: true, atualizados });
    }

    if (action === "motivos-erros") {
      // Pra cada faturamento ca_error, tenta achar o motivo cruzando com
      // contaazul_vendas (criadas mas com nf_erro) e analisando padrões.
      const sb = supaAdmin();
      const { data: erros } = await sb.from("faturamentos").select("*").eq("status", "ca_error");
      const empIds = Array.from(new Set((erros || []).map((e: any) => e.empresa_executora_id).filter(Boolean)));
      const { data: empresas } = await sb.from("empresas").select("id, nome_empresa, cnpj").in("id", empIds);
      const empById = new Map((empresas || []).map((e: any) => [e.id, e]));
      // Pega vendas no CA que possam corresponder
      const cnpjs = (erros || []).map((e: any) => {
        return String(e.cnpj_snapshot || empById.get(e.empresa_executora_id)?.cnpj || "").replace(/\D/g, "");
      }).filter(Boolean);
      const { data: vendasCA } = await sb.from("contaazul_vendas")
        .select("cnpj, valor, nf_status, nf_erro, boleto_status, boleto_erro, created_at")
        .in("cnpj", cnpjs)
        .order("created_at", { ascending: false });
      const vendasPorCnpj = new Map<string, any[]>();
      for (const v of vendasCA || []) {
        const k = String(v.cnpj || "").replace(/\D/g, "");
        if (!vendasPorCnpj.has(k)) vendasPorCnpj.set(k, []);
        vendasPorCnpj.get(k)!.push(v);
      }
      const items = (erros || []).map((f: any) => {
        const emp = empById.get(f.empresa_executora_id);
        const cnpj = String((f.cnpj_snapshot || emp?.cnpj || "")).replace(/\D/g, "");
        const nome = f.nome_empresa_snapshot || emp?.nome_empresa || "?";
        const vendas = vendasPorCnpj.get(cnpj) || [];
        // Match por valor — venda criada mas falhou na NF/boleto
        const valorMatch = vendas.find((v: any) => Math.abs(Number(v.valor || 0) - Number(f.valor || 0)) < 0.01);
        let motivo = "venda nao criada (erro antes do CA)";
        let categoria = "front_or_auth";
        if (valorMatch) {
          if (valorMatch.nf_erro) {
            motivo = `NF: ${String(valorMatch.nf_erro).slice(0, 200)}`;
            categoria = "nf_erro";
          } else if (valorMatch.boleto_erro) {
            motivo = `Boleto: ${String(valorMatch.boleto_erro).slice(0, 200)}`;
            categoria = "boleto_erro";
          } else {
            motivo = `Venda criada (#${valorMatch.numero || "?"}) mas status: NF=${valorMatch.nf_status}, Boleto=${valorMatch.boleto_status}`;
            categoria = "venda_criada";
          }
        }
        return { nome, cnpj, valor: f.valor, motivo, categoria };
      });
      // Agrega
      const porCategoria: Record<string, number> = {};
      for (const i of items) porCategoria[i.categoria] = (porCategoria[i.categoria] || 0) + 1;
      return res.status(200).json({ ok: true, total: items.length, por_categoria: porCategoria, items });
    }

    if (action === "diagnostico-erros") {
      // Lista faturamentos com status ca_error e cruza com vendas do CA
      // pra ver se foram faturadas manualmente depois.
      const competencia_id = (req.query.competencia_id as string) || undefined;
      const sb = supaAdmin();
      let q = sb.from("faturamentos").select("*").eq("status", "ca_error");
      if (competencia_id) q = q.eq("competencia_id", competencia_id);
      const { data: erros } = await q;
      // Resolve nomes via empresa_executora_id quando snapshot vier null
      const empIds = Array.from(new Set((erros || []).map((e: any) => e.empresa_executora_id).filter(Boolean)));
      const { data: empresas } = await sb.from("empresas").select("id, nome_empresa, cnpj").in("id", empIds);
      const empById = new Map((empresas || []).map((e: any) => [e.id, e]));
      // Enriquece erros com snapshot quando faltava
      for (const e of erros || []) {
        if (!e.cnpj_snapshot || !e.nome_empresa_snapshot) {
          const emp = empById.get(e.empresa_executora_id);
          if (emp) {
            e.cnpj_snapshot = e.cnpj_snapshot || emp.cnpj;
            e.nome_empresa_snapshot = e.nome_empresa_snapshot || emp.nome_empresa;
          }
        }
      }
      const cnpjs = (erros || []).map((e: any) => String(e.cnpj_snapshot || "").replace(/\D/g, "")).filter(Boolean);
      const { data: vendasCA } = await sb
        .from("contaazul_vendas")
        .select("ca_venda_id, cnpj, valor, data_venda, raw, nf_status, nf_numero")
        .in("cnpj", cnpjs);
      // Cruza
      const vendasPorCnpj = new Map<string, any[]>();
      for (const v of vendasCA || []) {
        const k = String(v.cnpj || "").replace(/\D/g, "");
        if (!vendasPorCnpj.has(k)) vendasPorCnpj.set(k, []);
        vendasPorCnpj.get(k)!.push(v);
      }
      const resultado = (erros || []).map((f: any) => {
        const cnpj = String(f.cnpj_snapshot || "").replace(/\D/g, "");
        const vendas = vendasPorCnpj.get(cnpj) || [];
        // Vendas do mesmo valor (provavelmente foram essas)
        const valorMatch = vendas.filter((v: any) => Math.abs(Number(v.valor || 0) - Number(f.valor || 0)) < 0.01);
        return {
          faturamento_id: f.id,
          empresa: f.nome_empresa_snapshot,
          cnpj: f.cnpj_snapshot,
          valor: f.valor,
          status: f.status,
          ja_faturado_no_ca: valorMatch.length > 0,
          vendas_ca_match: valorMatch.map((v: any) => ({
            numero: v.raw?.venda?.numero,
            id: v.ca_venda_id,
            valor: v.valor,
            data: v.data_venda,
            nf: v.nf_status,
            nf_num: v.nf_numero,
          })),
        };
      });
      return res.status(200).json({
        ok: true,
        total_erros: resultado.length,
        ja_faturados: resultado.filter((r: any) => r.ja_faturado_no_ca).length,
        a_refaturar: resultado.filter((r: any) => !r.ja_faturado_no_ca).length,
        items: resultado,
      });
    }

    if (action === "ultimas-vendas") {
      // Retorna as últimas vendas criadas com status de NF/boleto pra debug
      const sb = supaAdmin();
      const { data } = await sb
        .from("contaazul_vendas")
        .select("ca_venda_id, cnpj, servico, valor, data_venda, nf_status, nf_erro, nf_numero, boleto_status, boleto_erro, raw")
        .order("created_at", { ascending: false })
        .limit(10);
      return res.status(200).json({
        ok: true,
        vendas: (data || []).map((v: any) => ({
          venda_id: v.ca_venda_id,
          numero: v.raw?.venda?.numero,
          cnpj: v.cnpj,
          servico: v.servico,
          valor: v.valor,
          data: v.data_venda,
          nf: { status: v.nf_status, erro: v.nf_erro, numero: v.nf_numero },
          boleto: { status: v.boleto_status, erro: v.boleto_erro },
        })),
      });
    }

    if (action === "retencao-stats") {
      // Estatísticas das retenções nas empresas — pra verificar resultado da sync
      const sb = supaAdmin();
      const { data: empresas } = await sb.from("empresas").select("id, nome_empresa, cnpj, retem_iss, retem_ir, retem_inss, retem_pis_cofins_csll, regime_tributario, optante_simples, orgao_publico, retencao_atualizada_em, retencao_fonte");
      const total = empresas?.length || 0;
      const stats: any = {
        total,
        atualizadas: 0,
        nunca_atualizadas: 0,
        com_dados_validos: 0,
        com_override_manual: 0,
        cobertura_percent: 0,
        por_regime: { simples: 0, lucro_presumido_ou_real: 0, orgao_publico: 0, pessoa_fisica: 0, mei: 0, indefinido: 0 },
        retem_iss: { sim: 0, nao: 0, indefinido: 0 },
        pendentes: [] as any[], // Empresas que ficaram sem dado válido
      };
      for (const e of empresas || []) {
        if (e.retencao_atualizada_em) stats.atualizadas++;
        else stats.nunca_atualizadas++;
        if (e.retencao_fonte === "manual") stats.com_override_manual++;
        const r = e.regime_tributario || "indefinido";
        if (stats.por_regime[r] !== undefined) stats.por_regime[r]++;
        else stats.por_regime[r] = 1;
        if (e.retem_iss === true) stats.retem_iss.sim++;
        else if (e.retem_iss === false) stats.retem_iss.nao++;
        else stats.retem_iss.indefinido++;
        // Tem dado válido?
        const hasValidData = e.retem_iss !== null && r !== "indefinido";
        if (hasValidData) stats.com_dados_validos++;
        else {
          // Lista pra relatório
          stats.pendentes.push({
            id: e.id,
            nome: e.nome_empresa,
            cnpj: e.cnpj,
            regime: r,
            retencao_atualizada_em: e.retencao_atualizada_em,
            motivo: !e.retencao_atualizada_em ? "nunca_processada" : "api_falhou",
          });
        }
      }
      stats.cobertura_percent = total > 0 ? Math.round((stats.com_dados_validos / total) * 100) : 0;
      stats.is_100_percent = stats.com_dados_validos === total;
      return res.status(200).json(stats);
    }

    if (action === "debug") {
      const path = (req.query.path as string) || "/v1/pessoas?perPage=1";
      const method = (req.query.method as string)?.toUpperCase() || (req.method === "GET" ? "GET" : "POST");
      try {
        const r = await caApi(method, path, method === "GET" ? undefined : req.body);
        return res.status(200).json({ ok: true, data: r });
      } catch (err: any) {
        return res.status(200).json({ ok: false, error: err?.message });
      }
    }
    if (action === "create-receivable" || action === "create-sale") {
      if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
      const body: any = req.body || {};
      if (!body.cnpj || !body.servico || !body.valor) {
        return res.status(400).json({ error: "cnpj, servico e valor são obrigatórios" });
      }
      const cnpjDigits = String(body.cnpj).replace(/\D/g, "");
      if (cnpjDigits.length !== 14) return res.status(400).json({ error: "CNPJ inválido" });

      // 1. Busca pessoa por CNPJ — pode haver várias duplicadas; prefere a que já é Cliente
      let pessoa: any = null;
      try {
        const r = await caApi("GET", `/v1/pessoas?busca=${cnpjDigits}`);
        const items = (r?.items || r?.content || (Array.isArray(r) ? r : [])).filter(
          (p: any) => (p?.documento || "").replace(/\D/g, "") === cnpjDigits
        );
        const hasPerfil = (p: any, alvo: string) =>
          (p?.perfis || []).some((x: any) => (x?.tipo_perfil || x) === alvo);
        pessoa =
          items.find((p: any) => hasPerfil(p, "Cliente")) ||
          items[0] ||
          null;
      } catch (_) {}

      // 2. Cria pessoa se não existe
      if (!pessoa) {
        pessoa = await caApi("POST", "/v1/pessoas", {
          nome: body.razao_social || `Cliente ${cnpjDigits}`,
          documento: cnpjDigits,
          tipo_pessoa: "Jurídica",
          perfis: ["Cliente"],
          email: body.email || null,
        });
      }
      const personId = pessoa.id || pessoa.uuid || pessoa.uuid_pessoa;
      if (!personId) throw new Error("Falha ao obter id da pessoa na Conta Azul");

      // 3. Garante perfil Cliente (POST /v1/venda exige; pessoas existentes podem ser só Fornecedor)
      const perfisAtuais = (pessoa.perfis || []).map((p: any) => p?.tipo_perfil || p);
      if (!perfisAtuais.includes("Cliente")) {
        const novosPerfis = [
          { tipo_perfil: "Cliente" },
          ...perfisAtuais
            .filter((p: string) => p && p !== "Cliente")
            .map((p: string) => ({ tipo_perfil: p })),
        ];
        try {
          await caApi("PATCH", `/v1/pessoas/${personId}`, { perfis: novosPerfis });
        } catch (_) {}
      }

      // 4. Resolve serviço ATIVO + PRESTADO
      let servicoId = body.servico_id as string | undefined;
      let servicoNomeFinal: string = body.servico || "";
      let svcsCache: any[] | null = null;
      const carregarServicos = async () => {
        if (svcsCache) return svcsCache;
        // CA ignora ?perPage. Parâmetro correto é tamanho_pagina=100.
        const all: any[] = [];
        for (let pagina = 1; pagina <= 5; pagina++) {
          const r = await caApi("GET", `/v1/servicos?tamanho_pagina=100&pagina=${pagina}`);
          const items = r?.itens || r?.items || [];
          all.push(...items);
          if (items.length < 100) break;
        }
        svcsCache = all;
        return svcsCache!;
      };
      if (!servicoId) {
        const items = await carregarServicos();
        const ativoPrestado = items.find(
          (s: any) => s.status === "ATIVO" && s.tipo_servico === "PRESTADO"
        );
        servicoId = ativoPrestado?.id;
        servicoNomeFinal = ativoPrestado?.descricao || ativoPrestado?.nome || servicoNomeFinal;
      }
      if (!servicoId) {
        throw new Error("Nenhum serviço ATIVO + PRESTADO cadastrado na Conta Azul");
      }

      // 5. Cria venda em /v1/venda (Receita de Serviço — aceita NF e boleto)
      const dataVenda = body.data_venda || new Date().toISOString().slice(0, 10);
      const dataVenc = body.data_vencimento || dataVenda;
      const valor = Number(body.valor);
      const contaRecebimentoId =
        process.env.CONTA_AZUL_FINANCIAL_ACCOUNT_ID ||
        "49e2c1f3-c117-4882-82d0-e9ae9795f882";
      const categoriaId = body.categoria_id || undefined;
      const centroCustoId = body.centro_custo_id || undefined;
      // Busca cadastro da empresa MedX pra pegar retenções configuradas
      let retencoesConfig: any = null;
      try {
        const sbRet = supaAdmin();
        const { data: empMedX } = await sbRet
          .from("empresas")
          .select("retem_iss, retem_ir, retem_inss, retem_pis_cofins_csll, regime_tributario")
          .eq("cnpj", cnpjDigits)
          .maybeSingle();
        retencoesConfig = empMedX;
      } catch {}

      // Override manual via body tem precedência (caso usuário queira forçar)
      const retemIss = body.retem_iss !== undefined ? !!body.retem_iss : !!retencoesConfig?.retem_iss;
      const retemIr = body.retem_ir !== undefined ? !!body.retem_ir : !!retencoesConfig?.retem_ir;
      const retemInss = body.retem_inss !== undefined ? !!body.retem_inss : !!retencoesConfig?.retem_inss;
      const retemPisCofinsCsll = body.retem_pis_cofins_csll !== undefined ? !!body.retem_pis_cofins_csll : !!retencoesConfig?.retem_pis_cofins_csll;

      // 4.5. Se a empresa cliente RETÉM ISS, troca o serviço por uma versão
      // "com retenção" (cadastrada manualmente no CA).
      // Detecta pares como "EXAMES OCUPACIONAIS (Com Retenção de ISS)" vs
      // "EXAMES OCUPACIONAIS (Sem Retenção de ISS)" — mesmo nome base, sufixo diferente.
      let servicoTrocadoInfo: any = null;
      const nomeServ = (s: any) => String(s?.descricao || s?.nome || "");
      // Remove sufixos de retenção pra identificar nome "base" do serviço
      const nomeBase = (nome: string) =>
        nome
          .toLowerCase()
          .replace(/\(.*?retenç(?:ão|ao).*?\)/gi, "")
          .replace(/-?\s*com\s+retenç(?:ão|ao).*$/gi, "")
          .replace(/-?\s*sem\s+retenç(?:ão|ao).*$/gi, "")
          .replace(/-?\s*c\/\s*retenç(?:ão|ao).*$/gi, "")
          .replace(/-?\s*retido\b.*$/gi, "")
          .replace(/\s+/g, " ")
          .trim();
      const isComRetencao = (nome: string) => {
        const n = nome.toLowerCase();
        return /com\s+retenç(?:ão|ao)/.test(n) ||
               /c\/\s*retenç(?:ão|ao)/.test(n) ||
               /\bretido\b/.test(n);
      };
      if (retemIss) {
        try {
          const items = await carregarServicos();
          const servicoAtual = items.find((s: any) => s.id === servicoId);
          const nomeAtual = nomeServ(servicoAtual);
          const baseAtual = nomeBase(nomeAtual);
          if (baseAtual) {
            const candidato = items.find((s: any) => {
              if (s.id === servicoId) return false;
              if (s.status !== "ATIVO") return false;
              if (s.tipo_servico !== "PRESTADO") return false;
              const nome = nomeServ(s);
              if (!isComRetencao(nome)) return false;
              return nomeBase(nome) === baseAtual;
            });
            if (candidato) {
              servicoTrocadoInfo = {
                de: { id: servicoId, nome: nomeAtual },
                para: { id: candidato.id, nome: nomeServ(candidato) },
              };
              servicoId = candidato.id;
              servicoNomeFinal = nomeServ(candidato);
              console.log(`[create-receivable] CNPJ ${cnpjDigits} retém ISS — trocou "${nomeAtual}" → "${servicoNomeFinal}"`);
            } else {
              console.warn(`[create-receivable] CNPJ ${cnpjDigits} retém ISS, mas não achei versão "com retenção" pra base "${baseAtual}" (orig: "${nomeAtual}"). Mantendo original.`);
            }
          }
        } catch (e: any) {
          console.error(`[create-receivable] Falha ao trocar serviço por versão com retenção:`, e?.message);
        }
      }
      if (servicoTrocadoInfo) {
        body.servico = servicoNomeFinal;
      }

      const buildPayload = (numero: number) => ({
        id_cliente: personId,
        numero,
        data_venda: dataVenda,
        situacao: "APROVADO",
        observacoes: body.observacoes || undefined,
        itens: [
          {
            id: servicoId,
            descricao: body.servico,
            quantidade: 1,
            valor,
          },
        ],
        condicao_pagamento: {
          opcao_condicao_pagamento: "À vista",
          parcelas: [
            {
              numero_parcela: 1,
              valor,
              data_vencimento: dataVenc,
              descricao: body.servico,
              forma_pagamento: "BOLETO_BANCARIO",
              id_conta: contaRecebimentoId,
              ...(categoriaId ? { id_categoria: categoriaId } : {}),
              ...(centroCustoId ? { id_centro_de_custo: centroCustoId } : {}),
            },
          ],
        },
      });
      // NOTA: retenção (retem_iss/ir/inss/pis_cofins_csll) está no banco
      // mas o formato exato esperado pelo CA na criação de venda ainda
      // não está confirmado. Por hora, retenção é aplicada DEPOIS via BFF
      // ou manualmente no CA. Vamos descobrir o formato com 1 venda real
      // antes de aplicar automático aqui.
      void retemIss; void retemIr; void retemInss; void retemPisCofinsCsll;

      // Estratégia pra escolher próximo número da venda:
      // 1. Lê maior numero salvo no banco local (vendas criadas via MedX)
      // 2. Compara com env CONTA_AZUL_NUMERO_VENDA_INICIAL (limite mínimo)
      // 3. Filtra sanity: ignora numeros >= 1_000_000 (foram setados errados)
      // 4. Tenta com (base + 1)
      // 5. Se CA rejeita "nº NNN é o próximo", usa NNN
      const sbVendas = supaAdmin();
      const { data: prevVendas } = await sbVendas
        .from("contaazul_vendas")
        .select("raw")
        .not("raw", "is", null)
        .limit(200);
      let lastNumero = 0;
      for (const v of prevVendas || []) {
        const n = Number(v.raw?.venda?.numero);
        if (n > 0 && n < 1_000_000 && n > lastNumero) lastNumero = n;
      }
      const envBase = Number(process.env.CONTA_AZUL_NUMERO_VENDA_INICIAL || 0);
      const base = Math.max(lastNumero, envBase, 0);
      const tentativaInicial = base + 1;

      let venda: any;
      try {
        venda = await caApi("POST", "/v1/venda", buildPayload(tentativaInicial));
      } catch (err: any) {
        const m = String(err?.message || "").match(/nº\s+(\d+)/);
        if (!m) throw err;
        venda = await caApi("POST", "/v1/venda", buildPayload(Number(m[1])));
      }
      const vendaId = venda?.id || venda?.uuid || null;

      // 6. Emite NFS-e via BFF se solicitado
      let nfStatus = "nao_solicitada";
      let nfErro: string | null = null;
      let nfNumero: number | null = null;
      let nfInvoiceLegacyId: number | null = null;
      let nfPdfUrl: string | null = null;
      let nfChaveAcesso: string | null = null;

      if (body.emitir_nf && vendaId) {
        try {
          // Garante endereço da pessoa antes (prefeitura exige)
          await garantirEnderecoPessoa(personId, cnpjDigits);

          // Resolve legacyId via BFF
          const info = await caBffSession(
            "GET",
            `https://services.contaazul.com/contaazul-bff/sale/v1/sales/${vendaId}`
          );
          const legacyId = info.data?.legacyId || info.data?.id_legado;
          if (!info.ok || !legacyId) {
            throw new Error(`lookup BFF falhou: ${info.status} ${info.text?.slice(0, 150)}`);
          }

          // Issue
          const issue = await caBffSession(
            "POST",
            `https://services.contaazul.com/app/serviceinvoice/v2/issue/sale/${legacyId}`,
            {}
          );
          if (!issue.ok) {
            throw new Error(`issue ${issue.status}: ${issue.text?.slice(0, 200)}`);
          }
          nfInvoiceLegacyId =
            issue.data?.data || issue.data?.id || issue.data?.invoiceLegacyId || null;

          // Transmit (PUT)
          if (nfInvoiceLegacyId) {
            await caBffSession(
              "PUT",
              `https://services.contaazul.com/app/serviceinvoice/v2/${nfInvoiceLegacyId}/transmit`,
              {}
            );
            // Lê detalhes
            try {
              const d = await caBffSession(
                "GET",
                `https://services.contaazul.com/app/serviceinvoice/v2/${nfInvoiceLegacyId}`
              );
              const det = d.data?.data || d.data;
              nfNumero = det?.number || det?.rps?.number || null;
              // Extrai URLs da NF (vários nomes possíveis dependendo da prefeitura)
              nfPdfUrl =
                det?.pdfUrl || det?.urlPdf || det?.linkPdf ||
                det?.printUrl || det?.urlConsulta ||
                det?.rps?.pdfUrl || det?.rps?.urlPdf ||
                null;
              nfChaveAcesso =
                det?.accessKey || det?.chaveAcesso ||
                det?.rps?.accessKey || det?.rps?.chaveAcesso ||
                null;
              if (det?.status === "EMITIDA" || det?.status === "SUCESSO") {
                nfStatus = "emitida";
              } else if (det?.status === "FALHA") {
                nfStatus = "erro";
                nfErro = det?.rps?.error || "FALHA na prefeitura";
              } else {
                nfStatus = "em_processamento";
              }
            } catch (_) {
              nfStatus = "em_processamento";
            }
          }
        } catch (err: any) {
          nfStatus = "erro";
          nfErro = err?.message || "erro desconhecido";
        }
      }

      // 7. Emite boleto via BFF se solicitado
      let boletoStatus = "nao_solicitado";
      let boletoErro: string | null = null;
      let boletoUrl: string | null = null;
      let boletoLinhaDigitavel: string | null = null;

      if (body.emitir_boleto && vendaId) {
        try {
          // Retry pra esperar a CA popular financialEvent.installments com UUIDs
          // (pode demorar alguns segundos após /v1/venda criar a venda)
          let info: any = null;
          let inst: any[] = [];
          for (let attempt = 0; attempt < 5; attempt++) {
            if (attempt > 0) await new Promise((r) => setTimeout(r, 1500));
            info = await caBffSession(
              "GET",
              `https://services.contaazul.com/contaazul-bff/sale/v1/sales/${vendaId}`
            );
            if (info.ok) {
              inst =
                info.data?.financialEvent?.paymentCondition?.installments ||
                info.data?.financialEvents?.[0]?.paymentCondition?.installments ||
                [];
              if (inst.length && inst[0]?.id) break;
            }
          }
          if (!info.ok) {
            throw new Error(`lookup BFF ${info.status}: ${info.text?.slice(0, 150)}`);
          }
          const sale: any = info.data || {};
          // O BFF retorna installments com id+version dentro de
          // financialEvent.paymentCondition.installments. Os outros paths
          // (sale.installments, sale.parcelas, sale.paymentCondition.installments)
          // não trazem o UUID das parcelas, só metadados.
          const installments: any[] =
            sale.financialEvent?.paymentCondition?.installments ||
            (sale.financialEvents?.[0]?.paymentCondition?.installments) ||
            sale.installments || sale.parcelas || sale.paymentCondition?.installments || [];
          if (!installments.length) {
            throw new Error("venda sem installments");
          }
          const saleNumber = sale.number || sale.numero || sale.saleNumber || "?";
          const financialAccountId =
            process.env.CONTA_AZUL_FINANCIAL_ACCOUNT_ID ||
            "49e2c1f3-c117-4882-82d0-e9ae9795f882";
          const installmentGroups = installments.map((inst: any, idx: number) => ({
            description: `Venda ${saleNumber} - ${idx + 1}/${installments.length}`,
            dueDate: inst.dueDate || inst.data_vencimento || inst.due_date,
            index: idx + 1,
            installmentIds: [{ id: inst.id, version: inst.version ?? 0 }],
            originalDescription: `Venda ${saleNumber}`,
            value: inst.value ?? inst.amount ?? inst.valor,
          }));
          const r = await caBffSession(
            "POST",
            "https://services.contaazul.com/finance-pro/v2/charge-requests/batch-create",
            {
              financialAccountId,
              customAttributes: { charge: { type: "INVOICE" } },
              installmentGroups,
              type: "RECEBA_FACIL_BANK_SLIP",
            }
          );
          const jaExiste =
            !r.ok && r.status === 400 && /j[áa] existe.*cobran[çc]a/i.test(r.text || "");
          if (!r.ok && !jaExiste) {
            throw new Error(`batch-create ${r.status}: ${r.text?.slice(0, 200)}`);
          }
          boletoStatus = jaExiste ? "ja_emitido" : "solicitado";
          // Re-busca a venda pra ler chargeRequest com status atualizado
          try {
            const updated = await caBffSession(
              "GET",
              `https://services.contaazul.com/contaazul-bff/sale/v1/sales/${vendaId}`
            );
            const inst2 = updated.data?.financialEvent?.paymentCondition?.installments?.[0];
            const cr = inst2?.chargeRequests?.[0];
            if (cr) {
              boletoUrl = cr.url || null;
              boletoLinhaDigitavel = cr.digitableLine || cr.barcode || null;
              if (cr.status === "CONFIRMED" || inst2.authorizedBankSlipId) {
                boletoStatus = "emitido";
              } else if (cr.status === "AWAITING_CONFIRMATION") {
                boletoStatus = "aguardando_confirmacao";
              } else if (cr.status === "ERROR" || cr.errorDetail) {
                boletoStatus = "erro";
                boletoErro = cr.errorDetail || cr.status;
              }
            }
          } catch (_) {}
        } catch (err: any) {
          boletoStatus = "erro";
          boletoErro = err?.message || "erro desconhecido";
        }
      }

      // 8. Salva referência local
      const sb = supaAdmin();
      await sb.from("contaazul_vendas").insert({
        ca_venda_id: vendaId,
        cnpj: cnpjDigits,
        pessoa_id: personId,
        servico: body.servico,
        valor,
        data_venda: dataVenda,
        observacoes: body.observacoes || null,
        nf_status: nfStatus,
        nf_erro: nfErro,
        nf_numero: nfNumero,
        boleto_status: boletoStatus,
        boleto_erro: boletoErro,
        boleto_url: boletoUrl,
        boleto_linha_digitavel: boletoLinhaDigitavel,
        raw: { venda, nf_invoice_legacy_id: nfInvoiceLegacyId },
      });

      return res.status(200).json({
        ok: true,
        venda,
        pessoa: { id: personId, cnpj: cnpjDigits },
        nf: {
          status: nfStatus,
          erro: nfErro,
          numero: nfNumero,
          invoice_legacy_id: nfInvoiceLegacyId,
          pdf_url: nfPdfUrl,
          chave_acesso: nfChaveAcesso,
        },
        servico_trocado_iss: servicoTrocadoInfo,
        boleto: {
          status: boletoStatus,
          erro: boletoErro,
          url: boletoUrl,
          linha_digitavel: boletoLinhaDigitavel,
        },
      });
    }

    if (action === "check-nf") {
      // Consulta NFS-e emitida pra uma venda (a Conta Azul só expõe leitura via API).
      // ?venda_id=<uuid> — se o registro local existir, atualiza nf_status / nf_erro.
      const venda_id = (req.query.venda_id as string) || (req.body?.venda_id as string);
      if (!venda_id) return res.status(400).json({ error: "venda_id obrigatório" });
      const dataIni = (req.query.data_de as string) ||
        new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10);
      const dataFim = (req.query.data_ate as string) ||
        new Date().toISOString().slice(0, 10);
      const r = await caApi(
        "GET",
        `/v1/notas-fiscais-servico?pagina=1&tamanho_pagina=100&data_competencia_de=${dataIni}&data_competencia_ate=${dataFim}&id_venda=${venda_id}`
      );
      const items = (r?.itens || r?.items || []) as any[];
      const nf = items.find((n: any) => n.id_venda === venda_id) || null;
      const sb = supaAdmin();
      if (nf?.status === "EMITIDA") {
        await sb
          .from("contaazul_vendas")
          .update({
            nf_status: "emitida",
            nf_erro: null,
            nf_numero: nf.numero_nfse,
            nf_data: nf.informacao_transmissao?.data_inicio_emissao || null,
          })
          .eq("ca_venda_id", venda_id);
      } else if (nf?.status) {
        await sb
          .from("contaazul_vendas")
          .update({ nf_status: String(nf.status).toLowerCase(), nf_erro: null })
          .eq("ca_venda_id", venda_id);
      }
      return res.status(200).json({ ok: true, nf, total_no_periodo: items.length });
    }

    if (action === "emit-nf") {
      // Emissão real de NFS-e via endpoints internos BFF (services.contaazul.com)
      // Auth via cookie x-ca-auth (precisa estar configurado em set-bff-cookies).
      if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
      const { venda_id, sale_id, legacy_id } = (req.body || {}) as {
        venda_id?: string;
        sale_id?: string;
        legacy_id?: number | string;
      };
      const saleId = sale_id || venda_id;
      if (!saleId && !legacy_id) {
        return res.status(400).json({ error: "venda_id (uuid) ou legacy_id obrigatório" });
      }

      // 1. Resolve legacy_id + cnpj + personId via BFF
      let legacyId = legacy_id ? Number(legacy_id) : null;
      let personId: string | null = null;
      let cnpj: string | null = null;
      if (saleId) {
        const info = await caBffSession(
          "GET",
          `https://services.contaazul.com/contaazul-bff/sale/v1/sales/${saleId}`
        );
        if (!info.ok) {
          return res.status(200).json({ ok: false, step: "lookup-sale", status: info.status, text: info.text });
        }
        if (!legacyId) legacyId = info.data?.legacyId || info.data?.id_legado || null;
        personId = info.data?.negotiatorId || null;
        // CNPJ pode não vir; vai ser recuperado da pessoa abaixo se preciso
      }
      if (!legacyId) {
        return res.status(200).json({ ok: false, step: "lookup-sale", error: "legacyId não resolvido" });
      }

      // 2. Garante endereço completo da pessoa (prefeitura exige)
      if (personId) {
        try {
          if (!cnpj) {
            const p = await caApi("GET", `/v1/pessoas/${personId}`);
            cnpj = (p?.documento || "").replace(/\D/g, "") || null;
          }
          if (cnpj && cnpj.length === 14) {
            await garantirEnderecoPessoa(personId, cnpj);
          }
        } catch (err: any) {
          const sb = supaAdmin();
          await sb
            .from("contaazul_vendas")
            .update({ nf_status: "erro", nf_erro: `endereço: ${err?.message?.slice(0, 200)}` })
            .eq("ca_venda_id", saleId || "");
          return res.status(200).json({ ok: false, step: "endereco", error: err?.message });
        }
      }

      // 3. Cria a NFS-e a partir da venda — POST /issue/sale/{legacy}
      const issue = await caBffSession(
        "POST",
        `https://services.contaazul.com/app/serviceinvoice/v2/issue/sale/${legacyId}`,
        {}
      );
      if (!issue.ok) {
        const sb = supaAdmin();
        await sb
          .from("contaazul_vendas")
          .update({ nf_status: "erro", nf_erro: `issue ${issue.status}: ${issue.text?.slice(0, 200)}` })
          .eq("ca_venda_id", saleId || "");
        return res.status(200).json({ ok: false, step: "issue", status: issue.status, text: issue.text });
      }

      // Response da issue: { data: 87294720 }
      const invoiceLegacyId =
        issue.data?.data ||
        issue.data?.id ||
        issue.data?.invoiceLegacyId ||
        issue.data?.legacyId;

      if (!invoiceLegacyId) {
        return res.status(200).json({ ok: false, step: "issue", error: "invoiceLegacyId ausente", data: issue.data });
      }

      // 4. Transmite a NF — PUT /{invoice}/transmit (não POST)
      const tr = await caBffSession(
        "PUT",
        `https://services.contaazul.com/app/serviceinvoice/v2/${invoiceLegacyId}/transmit`,
        {}
      );

      // 5. Lê detalhes da NF pra capturar status real (SUCESSO / FALHA / EM_PROCESSAMENTO)
      let detail: any = null;
      try {
        const d = await caBffSession(
          "GET",
          `https://services.contaazul.com/app/serviceinvoice/v2/${invoiceLegacyId}`
        );
        detail = d.data?.data || d.data || null;
      } catch (_) {}

      const nfStatus = detail?.status === "EMITIDA" || detail?.status === "SUCESSO"
        ? "emitida"
        : detail?.status === "FALHA"
          ? "erro"
          : "em_processamento";
      const nfErro = detail?.rps?.error || null;
      const nfNumero = detail?.number || detail?.rps?.number || null;

      const sb = supaAdmin();
      await sb
        .from("contaazul_vendas")
        .update({ nf_status: nfStatus, nf_erro: nfErro, nf_numero: nfNumero })
        .eq("ca_venda_id", saleId || "");

      return res.status(200).json({
        ok: nfStatus === "emitida" || nfStatus === "em_processamento",
        legacy_id: legacyId,
        invoice_legacy_id: invoiceLegacyId,
        nf_status: nfStatus,
        nf_numero: nfNumero,
        nf_erro: nfErro,
        transmit_http: tr.status,
        detail,
      });
    }

    if (action === "list-vendas") {
      // Lista contaazul_vendas locais (recentes primeiro) com status NF/boleto
      const sb = supaAdmin();
      const { data } = await sb
        .from("contaazul_vendas")
        .select("ca_venda_id, cnpj, servico, valor, data_venda, nf_status, nf_numero, boleto_status, boleto_url, created_at")
        .order("created_at", { ascending: false })
        .limit(20);
      return res.status(200).json({ ok: true, vendas: data || [] });
    }

    if (action === "cancel-venda") {
      // Cancela venda na CA (DELETE) + remove referência local
      if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
      const { venda_id } = (req.body || {}) as { venda_id?: string };
      if (!venda_id) return res.status(400).json({ error: "venda_id obrigatório" });
      let caResult: any = null;
      let caError: string | null = null;
      try {
        caResult = await caApi("DELETE", `/v1/venda/${venda_id}`);
      } catch (err: any) {
        caError = err?.message || "erro CA";
      }
      const sb = supaAdmin();
      await sb.from("contaazul_vendas").delete().eq("ca_venda_id", venda_id);
      return res.status(200).json({
        ok: !caError,
        ca_result: caResult,
        ca_error: caError,
        local_removed: true,
      });
    }

    if (action === "emit-boleto") {
      // Emissão de boleto via BFF interno — POST /finance-pro/v2/charge-requests/batch-create
      // Auth via cookie x-ca-auth (set-bff-cookies). Conta financeira é a Receba Fácil.
      if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
      const { venda_id, sale_id } = (req.body || {}) as {
        venda_id?: string;
        sale_id?: string;
      };
      const saleId = sale_id || venda_id;
      if (!saleId) return res.status(400).json({ error: "venda_id obrigatório" });

      // 1. Busca venda no BFF — precisamos do número, parcelas (id+version+vencimento+valor)
      const info = await caBffSession(
        "GET",
        `https://services.contaazul.com/contaazul-bff/sale/v1/sales/${saleId}`
      );
      if (!info.ok) {
        return res.status(200).json({ ok: false, step: "lookup-sale", status: info.status, text: info.text });
      }
      const sale: any = info.data || {};
      // financialEvent.paymentCondition.installments é o único path que tem id+version
      const installments: any[] =
        sale.financialEvent?.paymentCondition?.installments ||
        (sale.financialEvents?.[0]?.paymentCondition?.installments) ||
        sale.installments || sale.parcelas || sale.paymentCondition?.installments || [];
      if (!installments.length) {
        return res.status(200).json({
          ok: false,
          step: "lookup-sale",
          error: "venda sem installments na resposta BFF",
          sample_keys: Object.keys(sale),
        });
      }
      const saleNumber = sale.number || sale.numero || sale.saleNumber || "?";

      const financialAccountId =
        process.env.CONTA_AZUL_FINANCIAL_ACCOUNT_ID ||
        "49e2c1f3-c117-4882-82d0-e9ae9795f882";

      const installmentGroups = installments.map((inst: any, idx: number) => ({
        description: `Venda ${saleNumber} - ${idx + 1}/${installments.length}`,
        dueDate: inst.dueDate || inst.data_vencimento || inst.due_date,
        index: idx + 1,
        installmentIds: [{ id: inst.id, version: inst.version ?? 0 }],
        originalDescription: `Venda ${saleNumber}`,
        value: inst.value ?? inst.amount ?? inst.valor,
      }));

      const payload = {
        financialAccountId,
        customAttributes: { charge: { type: "INVOICE" } },
        installmentGroups,
        type: "RECEBA_FACIL_BANK_SLIP",
      };

      const r = await caBffSession(
        "POST",
        "https://services.contaazul.com/finance-pro/v2/charge-requests/batch-create",
        payload
      );

      let boletoStatus = "erro";
      let boletoErro: string | null = null;
      let boletoUrl: string | null = null;
      let boletoLinhaDigitavel: string | null = null;
      // Se 400 com "Já existe requisição de cobrança", tratamos como sucesso
      // (significa que o boleto já foi emitido em chamada anterior).
      const jaExiste =
        !r.ok &&
        r.status === 400 &&
        /j[áa] existe.*cobran[çc]a/i.test(r.text || "");

      if (r.ok || jaExiste) {
        boletoStatus = jaExiste ? "ja_emitido" : "solicitado";
        // Re-busca a venda no BFF pra ler o chargeRequest com status atualizado
        try {
          const updated = await caBffSession(
            "GET",
            `https://services.contaazul.com/contaazul-bff/sale/v1/sales/${saleId}`
          );
          const inst = updated.data?.financialEvent?.paymentCondition?.installments?.[0];
          const cr = inst?.chargeRequests?.[0];
          if (cr) {
            boletoUrl = cr.url || null;
            boletoLinhaDigitavel = cr.digitableLine || cr.barcode || null;
            // Se status do boleto já tá confirmado, marca como "emitido"
            if (cr.status === "CONFIRMED" || inst.authorizedBankSlipId) {
              boletoStatus = "emitido";
            } else if (cr.status === "AWAITING_CONFIRMATION") {
              boletoStatus = "aguardando_confirmacao";
            } else if (cr.status === "ERROR" || cr.errorDetail) {
              boletoStatus = "erro";
              boletoErro = cr.errorDetail || cr.status;
            }
          }
        } catch (_) {}
      } else {
        boletoErro = `${r.status}: ${r.text?.slice(0, 200)}`;
      }

      const sb = supaAdmin();
      await sb
        .from("contaazul_vendas")
        .update({
          boleto_status: boletoStatus,
          boleto_erro: boletoErro,
          boleto_url: boletoUrl,
          boleto_linha_digitavel: boletoLinhaDigitavel,
        })
        .eq("ca_venda_id", saleId);

      return res.status(200).json({
        ok: r.ok,
        status: boletoStatus,
        erro: boletoErro,
        url: boletoUrl,
        linha_digitavel: boletoLinhaDigitavel,
        payload_enviado: payload,
        raw: r.data,
      });
    }

    if (action === "check-boleto") {
      // Re-consulta o BFF e atualiza o status do boleto (URL, linha digitável)
      // Usado pra polling após "aguardando_confirmacao".
      const venda_id = (req.query.venda_id as string) || (req.body?.venda_id as string);
      if (!venda_id) return res.status(400).json({ error: "venda_id obrigatório" });
      const r = await caBffSession(
        "GET",
        `https://services.contaazul.com/contaazul-bff/sale/v1/sales/${venda_id}`
      );
      if (!r.ok) {
        return res.status(200).json({ ok: false, status: r.status });
      }
      const inst = r.data?.financialEvent?.paymentCondition?.installments?.[0];
      const cr = inst?.chargeRequests?.[0];
      if (!cr) {
        return res.status(200).json({ ok: false, error: "sem chargeRequest — boleto não emitido" });
      }
      let boleto_status = "aguardando_confirmacao";
      if (cr.status === "CONFIRMED" || inst.authorizedBankSlipId) boleto_status = "emitido";
      else if (cr.status === "ERROR" || cr.errorDetail) boleto_status = "erro";
      const boleto_url = cr.url || null;
      const boleto_linha_digitavel = cr.digitableLine || cr.barcode || null;
      const sb = supaAdmin();
      await sb.from("contaazul_vendas")
        .update({ boleto_status, boleto_url, boleto_linha_digitavel })
        .eq("ca_venda_id", venda_id);
      return res.status(200).json({
        ok: true,
        boleto_status,
        boleto_url,
        boleto_linha_digitavel,
        charge_request_status: cr.status,
      });
    }

    if (action === "cognito-login") {
      // Login interativo Cognito (1x quando refresh expirar — ~30 dias)
      // POST { email, senha, totp_code? }
      if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
      const { email, senha, totp_code } = (req.body || {}) as {
        email?: string;
        senha?: string;
        totp_code?: string;
      };
      if (!email || !senha) {
        return res.status(400).json({ error: "email e senha obrigatórios" });
      }
      try {
        const sess = await cognitoLoginInteractive(email, senha, totp_code);
        return res.status(200).json({
          ok: true,
          email: sess.email,
          access_token_expires_at: sess.expires_at,
          mensagem: "Login Cognito ok. Refresh válido por ~30 dias.",
        });
      } catch (err: any) {
        const msg = err?.message || "erro desconhecido";
        const mfaRequired = msg.startsWith("MFA_REQUIRED");
        return res.status(mfaRequired ? 200 : 500).json({
          ok: false,
          mfa_required: mfaRequired,
          error: msg,
        });
      }
    }

    if (action === "refresh-session") {
      // Renova AccessToken via refresh_token Cognito (sem MFA).
      // Chamado pelo cron Vercel a cada 6h.
      try {
        const sess = await cognitoRefresh();
        return res.status(200).json({
          ok: true,
          email: sess.email,
          access_token_expires_at: sess.expires_at,
        });
      } catch (err: any) {
        return res.status(200).json({ ok: false, error: err?.message });
      }
    }

    if (action === "cognito-status") {
      const s = await cognitoStatus();
      return res.status(200).json(s);
    }

    return res.status(404).json({ error: `action desconhecida: ${action}` });
  } catch (err: any) {
    return res.status(500).json({ ok: false, error: err?.message });
  }
}
