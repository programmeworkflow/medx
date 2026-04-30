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
} from "./_caCognito.js";

// Garante que a pessoa na Conta Azul tem endereço completo (exigido pra NFS-e
// pela maioria das prefeituras). Tenta puxar do registro local da empresa em
// `empresas` e, se faltar, completa com BrasilAPI usando o CNPJ.
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
      //   { vendaId, emails?: string[], senderEmail?, senderName?, viewOptions? }
      // Se emails não vier, busca defaults do billingContact da venda.
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
      const customerId =
        info.data?.customer?.id ||
        info.data?.customerId ||
        info.data?.financialEvent?.paymentCondition?.installments?.[0]?.chargeRequests?.[0]?.customerId;
      if (!customerId) {
        return res.status(500).json({ error: "customerId não encontrado na venda" });
      }

      // 2. Resolve emails: se body.emails veio, usa. Senão pede ao billing-contact.
      let emails: string[] = Array.isArray(body.emails) ? body.emails.filter(Boolean) : [];
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
      if (emails.length === 0) {
        return res.status(400).json({ error: "Sem emails de destinatário" });
      }

      // 3. POST do envio
      const payload = {
        customerMail: emails.join(","),
        notificationReference: vendaId,
        registryId: customerId,
        senderEmail: body.senderEmail || "",
        senderName: body.senderName || "",
        viewOptions: body.viewOptions || {},
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
      return res.status(200).json({ ok: true, emails, response: r.data });
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
        info.data?.customer?.id ||
        info.data?.customerId ||
        info.data?.financialEvent?.paymentCondition?.installments?.[0]?.chargeRequests?.[0]?.customerId;
      const customerName =
        info.data?.customer?.name || info.data?.customerName || "";
      let emails: string[] = [];
      if (customerId) {
        const bc = await caBffSession(
          "GET",
          `https://services.contaazul.com/billing/contact?customerId=${customerId}`
        );
        if (bc.ok) {
          emails = (bc.data?.billingContact?.emails || bc.data?.emails || []).filter(Boolean);
        }
      }
      return res.status(200).json({ emails, customerName, customerId });
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

      // 4. Resolve serviço ATIVO + PRESTADO (Receita de Serviço exige serviço ativo)
      let servicoId = body.servico_id as string | undefined;
      if (!servicoId) {
        const svcs = await caApi("GET", "/v1/servicos?perPage=200");
        const items = svcs?.itens || svcs?.items || [];
        const ativoPrestado = items.find(
          (s: any) => s.status === "ATIVO" && s.tipo_servico === "PRESTADO"
        );
        servicoId = ativoPrestado?.id;
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
        nf: { status: nfStatus, erro: nfErro, numero: nfNumero, invoice_legacy_id: nfInvoiceLegacyId },
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
