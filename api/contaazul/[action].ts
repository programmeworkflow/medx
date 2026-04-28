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
      try {
        const r = await caApi("GET", path);
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

      // 1. Busca pessoa por CNPJ (Conta Azul retorna { items: [...] })
      let pessoa: any = null;
      try {
        const r = await caApi("GET", `/v1/pessoas?busca=${cnpjDigits}`);
        const items = r?.items || r?.content || (Array.isArray(r) ? r : []);
        pessoa = items.find((p: any) => (p?.documento || "").replace(/\D/g, "") === cnpjDigits) || null;
      } catch (_) {}

      // 2. Cria pessoa se não existe
      if (!pessoa) {
        const created = await caApi("POST", "/v1/pessoas", {
          nome: body.razao_social || `Cliente ${cnpjDigits}`,
          documento: cnpjDigits,
          tipo_pessoa: "Jurídica",
          perfis: ["Cliente"],
          email: body.email || null,
        });
        pessoa = created;
      }
      const personId = pessoa.id || pessoa.uuid || pessoa.uuid_pessoa;
      if (!personId) throw new Error("Falha ao obter id da pessoa na Conta Azul");

      // 3. Cria conta a receber (na nova API substitui "venda")
      const dataVenda = body.data_venda || new Date().toISOString().slice(0, 10);
      // Categoria receita default — pega a primeira categoria de tipo RECEITA disponível
      let categoriaId = body.categoria_id as string | undefined;
      if (!categoriaId) {
        try {
          const cats = await caApi("GET", "/v1/categorias?perPage=200");
          const receita = (cats?.itens || []).find((c: any) => c.tipo === "RECEITA");
          categoriaId = receita?.id;
        } catch (_) {}
      }
      if (!categoriaId) throw new Error("Nenhuma categoria de RECEITA cadastrada na Conta Azul");

      const valor = Number(body.valor);

      // Resolve serviço (necessário pra classificar como "Receita de serviço")
      let servicoId = body.servico_id as string | undefined;
      if (!servicoId) {
        try {
          const svcs = await caApi("GET", "/v1/servicos?perPage=200");
          const items = svcs?.itens || svcs?.items || [];
          const prestado = items.find((s: any) => s.tipo_servico === "PRESTADO") || items[0];
          servicoId = prestado?.id;
        } catch (_) {}
      }

      const ratioRow: any = { id_categoria: categoriaId, valor };
      if (body.centro_custo_id) {
        ratioRow.rateio_centro_custo = [
          { id_centro_custo: body.centro_custo_id, valor },
        ];
      }
      if (servicoId) {
        // Tenta vincular o serviço dentro do rateio também — schema da Conta Azul ainda incerto
        ratioRow.id_servico = servicoId;
      }

      const payload: any = {
        tipo_lancamento: "SERVICO",
        data_competencia: dataVenda,
        valor,
        descricao: body.servico,
        observacao: body.observacoes || null,
        contato: personId,
        rateio: [ratioRow],
        condicao_pagamento: {
          tipo: "A_VISTA",
          parcelas: [
            {
              numero_parcela: 1,
              valor,
              data_vencimento: dataVenda,
              descricao: body.servico,
              detalhe_valor: {
                valor_bruto: valor,
                valor_liquido: valor,
                multa: 0,
                juros: 0,
                desconto: 0,
                taxa: 0,
              },
            },
          ],
        },
      };
      if (servicoId) {
        // Candidatos de campo top-level pra classificar como Receita de Serviço
        payload.vinculo_servico_id = servicoId;
        payload.id_servico = servicoId;
        payload.servico_id = servicoId;
      }
      const venda = await caApi("POST", "/v1/financeiro/eventos-financeiros/contas-a-receber", payload);

      // 4. Salva referência local
      const sb = supaAdmin();
      await sb.from("contaazul_vendas").insert({
        ca_venda_id: venda?.id || venda?.uuid || null,
        cnpj: cnpjDigits,
        pessoa_id: personId,
        servico: body.servico,
        valor: Number(body.valor),
        data_venda: dataVenda,
        observacoes: body.observacoes || null,
        raw: venda,
      });

      return res.status(200).json({ ok: true, venda, pessoa: { id: personId, cnpj: cnpjDigits } });
    }

    return res.status(404).json({ error: `action desconhecida: ${action}` });
  } catch (err: any) {
    return res.status(500).json({ ok: false, error: err?.message });
  }
}
