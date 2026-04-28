import type { VercelRequest, VercelResponse } from "@vercel/node";
import crypto from "node:crypto";
import { supaAdmin, corsHeaders } from "../esocial/_lib.js";
import {
  getAuthorizeUrl,
  exchangeCode,
  loadTokens,
  caApi,
  FRONT_URL,
} from "./_ca.js";

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

      // 6. NF — Conta Azul não permite emitir NFS-e via API (somente consulta).
      // Marca pendente_manual quando solicitado; o user emite na UI da CA ou via contrato auto.
      const nfStatus: string = body.emitir_nf ? "pendente_manual" : "nao_solicitada";

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
        raw: { venda },
      });

      return res.status(200).json({
        ok: true,
        venda,
        pessoa: { id: personId, cnpj: cnpjDigits },
        nf: { status: nfStatus },
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
      // A API v2 da Conta Azul NÃO permite emitir NFS-e programaticamente.
      // Mantém o endpoint pra compatibilidade — só marca pendente_manual.
      if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
      const { venda_id } = (req.body || {}) as { venda_id?: string };
      if (!venda_id) return res.status(400).json({ error: "venda_id obrigatório" });
      const sb = supaAdmin();
      await sb
        .from("contaazul_vendas")
        .update({ nf_status: "pendente_manual" })
        .eq("ca_venda_id", venda_id);
      return res.status(200).json({
        ok: true,
        message:
          "API Conta Azul não permite emitir NFS-e via API. Emita manualmente na UI da Conta Azul (menu Vendas > venda > Nota Fiscal) ou configure um contrato com emissão automática.",
        venda_id,
      });
    }

    return res.status(404).json({ error: `action desconhecida: ${action}` });
  } catch (err: any) {
    return res.status(500).json({ ok: false, error: err?.message });
  }
}
