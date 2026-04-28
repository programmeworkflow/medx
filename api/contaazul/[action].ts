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
} from "./_ca.js";
import { caBffSession, saveBffCookies, loadBffCookies } from "./_caCognito.js";

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
      if (error) return res.redirect(302, `${FRONT_URL}/faturamento?ca_error=${encodeURIComponent(error)}`);
      if (!code) return res.status(400).send("Faltou parâmetro code");
      try {
        await exchangeCode(code);
        return res.redirect(302, `${FRONT_URL}/faturamento?ca_connected=1`);
      } catch (err: any) {
        return res.redirect(302, `${FRONT_URL}/faturamento?ca_error=${encodeURIComponent(err?.message || "callback failed")}`);
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

    if (action === "cost-centers") {
      // Lista centros de custo com filtro opcional ?busca=
      const busca = (req.query.busca as string) || "";
      const r = await caApi(
        "GET",
        busca ? `/v1/centro-de-custo?busca=${encodeURIComponent(busca)}` : "/v1/centro-de-custo?perPage=10"
      );
      return res.status(200).json({
        items: (r?.itens || []).map((c: any) => ({ id: c.id, nome: c.nome })),
      });
    }

    if (action === "services") {
      // Lista serviços cadastrados (necessário pra classificar como "Receita de serviço")
      const r = await caApi("GET", "/v1/servicos?perPage=200");
      const items = r?.itens || r?.items || r?.content || [];
      return res.status(200).json({
        items: items.map((s: any) => ({
          id: s.id,
          nome: s.nome || s.descricao,
          tipo_servico: s.tipo_servico,
        })),
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
      const valor = Number(body.valor);
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
              data_vencimento: dataVenda,
              descricao: body.servico,
            },
          ],
        },
      });

      let venda: any;
      try {
        venda = await caApi("POST", "/v1/venda", buildPayload(1));
      } catch (err: any) {
        // Conta Azul devolve "O nº NNN é o próximo disponível" no erro
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

      // 7. Salva referência local
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
        raw: { venda, nf_invoice_legacy_id: nfInvoiceLegacyId },
      });

      return res.status(200).json({
        ok: true,
        venda,
        pessoa: { id: personId, cnpj: cnpjDigits },
        nf: { status: nfStatus, erro: nfErro, numero: nfNumero, invoice_legacy_id: nfInvoiceLegacyId },
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

    return res.status(404).json({ error: `action desconhecida: ${action}` });
  } catch (err: any) {
    return res.status(500).json({ ok: false, error: err?.message });
  }
}
