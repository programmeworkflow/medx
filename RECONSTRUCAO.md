# MedX — Reconstrução pós-reset (2026-04-24)

Este documento resume **o que foi recriado** e **o que precisa ser configurado manualmente** antes do deploy.

## O que foi recriado

### Frontend
- **Sidebar** atualizada: `Empresas` virou `Cadastro`; adicionado item `Treinamentos` com ícone `GraduationCap`
- **Página `/cadastro`** com sub-abas:
  - `01 — Empresas` (página existente estendida)
  - `02 — Credenciadas` (página nova)
- **Empresas**: adicionados campos
  - `vidas_contrato` (vidas inclusas no contrato)
  - `vidas_eso` (vidas no ESO)
  - `data_fechamento_especial`
  - `janela_fechamento`
  - Template xlsx de importação estendido com esses campos + parser atualizado
- **Credenciadas** (novo):
  - CRUD completo com CNPJ, nome, contrato (sim/não + data), email faturamento, correios (+ endereço + CEP condicional), observações, upload do contrato, upload da tabela de preços
  - Indicador visual de contratos próximos de 1 ano, vencidos 1 ano, vencidos 2+ anos
- **Treinamentos** (novo):
  - CRUD com nome, empresa, modalidade (presencial/EAD), diária de instrutor (condicional), valor bruto, data do treinamento, data do pagamento
  - Comissão calculada automaticamente (7% fixo, via coluna gerada no banco)
  - Dashboard com 4 stats: quantidade, valor bruto, comissão total, média por treinamento
  - Filtro por mês

### Backend (Supabase)
- Migration `20260424100000_add_credenciadas_treinamentos.sql`:
  - Novos campos em `empresas`
  - Tabela `credenciadas` + RLS
  - Tabela `treinamentos` + enum `modalidade_treinamento` + coluna gerada `valor_comissao` (7% de `valor_bruto`)
  - Storage buckets privados: `contratos-credenciadas` e `tabelas-preco`
- Edge Function `alerta-credenciadas`: envia email diário ao admin com credenciadas pendentes de reajuste
- Migration `20260424110000_schedule_alerta_credenciadas.sql`: agenda via pg_cron seg-sex às 08h BRT

---

## Configuração manual necessária

### 1. Rodar as migrations no Supabase
No projeto Supabase, `Database → Migrations → Apply pending`, ou `supabase db push` via CLI.

### 2. Deploy da Edge Function
```bash
supabase functions deploy alerta-credenciadas
```

### 3. Configurar segredos da Edge Function
Em `Project Settings → Edge Functions → Secrets`:

| Secret                  | Valor                                                    |
|-------------------------|----------------------------------------------------------|
| `RESEND_API_KEY`        | Conta grátis em https://resend.com, `re_xxx...`          |
| `ALERTA_EMAIL_TO`       | E-mail que recebe os alertas (ex: `admin@medwork.com.br`)|
| `ALERTA_EMAIL_FROM`     | Remetente validado no Resend (ex: `alertas@medwork.com`) |

Sem `RESEND_API_KEY` a função roda em dry-run (retorna a lista mas não envia email).

### 4. Agendar o cron (se plano Free do Supabase)
Planos pagos já aplicam via migration. Free: `Database → Cron Jobs → New` com:
- Name: `alerta-credenciadas-diario`
- Schedule: `0 11 * * 1-5`
- SQL:
  ```sql
  SELECT net.http_post(
    url := 'https://<PROJECT-REF>.supabase.co/functions/v1/alerta-credenciadas',
    headers := jsonb_build_object('Authorization', 'Bearer <SERVICE-ROLE-KEY>', 'Content-Type', 'application/json'),
    body := '{}'::jsonb
  );
  ```

### 5. Vercel — conectar ao GitHub
Com o repo publicado no GitHub:
- `Vercel → Project Settings → Git → Connect Git Repository → selecionar medx-flow`
- Framework: **Vite**
- Env vars copiar do `.env.local`:
  - `VITE_SUPABASE_URL`
  - `VITE_SUPABASE_PUBLISHABLE_KEY`

---

## Decisões que ficaram diferentes do original

- **Janelas de fechamento**: virou campo próprio (`janela_fechamento` + `data_fechamento_especial`), não ficou só em observações
- **Credenciadas**: tabela separada de `empresas` (mantendo `credenciada` no enum de categoria por compatibilidade, mas as duas coisas são independentes agora)
- **Comissão de treinamento**: fixa em 7% no banco (coluna gerada). Se no futuro precisar comissão variável por treinamento, substitua a `GENERATED ALWAYS AS` por uma coluna normal
