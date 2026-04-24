-- ============================================================================
-- Reconstrução pós-reset: Credenciadas, Treinamentos, Vidas no Contrato/ESO
-- Data: 2026-04-24
-- ============================================================================

-- ────────────────────────────────────────────────────────────────────────────
-- 1) Novos campos em empresas
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.empresas
  ADD COLUMN IF NOT EXISTS vidas_contrato INTEGER,
  ADD COLUMN IF NOT EXISTS vidas_eso      INTEGER,
  ADD COLUMN IF NOT EXISTS data_fechamento_especial DATE,
  ADD COLUMN IF NOT EXISTS janela_fechamento TEXT;

COMMENT ON COLUMN public.empresas.vidas_contrato            IS 'Quantidade de vidas inclusas no contrato';
COMMENT ON COLUMN public.empresas.vidas_eso                  IS 'Quantidade de vidas registradas no ESO';
COMMENT ON COLUMN public.empresas.data_fechamento_especial   IS 'Data especial de fechamento (null = usa dia padrão da competência)';
COMMENT ON COLUMN public.empresas.janela_fechamento          IS 'Descrição livre da janela de fechamento (ex: "do dia 20 ao dia 20")';

-- ────────────────────────────────────────────────────────────────────────────
-- 2) Tabela credenciadas
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.credenciadas (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  nome               TEXT NOT NULL,
  cnpj               TEXT NOT NULL UNIQUE,
  possui_contrato    BOOLEAN NOT NULL DEFAULT false,
  data_contrato      DATE,
  email_faturamento  TEXT,
  envia_correios     BOOLEAN NOT NULL DEFAULT false,
  endereco_despacho  TEXT,
  cep                TEXT,
  tabela_preco_url   TEXT,   -- caminho no bucket tabelas-preco
  contrato_url       TEXT,   -- caminho no bucket contratos-credenciadas
  observacoes        TEXT,
  ativa              BOOLEAN NOT NULL DEFAULT true,
  criado_em          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  atualizado_em      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_credenciadas_cnpj ON public.credenciadas(cnpj);
CREATE INDEX IF NOT EXISTS idx_credenciadas_data_contrato ON public.credenciadas(data_contrato);

ALTER TABLE public.credenciadas ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read credenciadas"   ON public.credenciadas FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated users can insert credenciadas" ON public.credenciadas FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated users can update credenciadas" ON public.credenciadas FOR UPDATE TO authenticated USING (true);
CREATE POLICY "Authenticated users can delete credenciadas" ON public.credenciadas FOR DELETE TO authenticated USING (true);

-- Trigger pra atualizar atualizado_em automaticamente
CREATE OR REPLACE FUNCTION public.set_atualizado_em()
RETURNS TRIGGER AS $$
BEGIN
  NEW.atualizado_em = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER credenciadas_set_atualizado_em
  BEFORE UPDATE ON public.credenciadas
  FOR EACH ROW
  EXECUTE FUNCTION public.set_atualizado_em();

-- ────────────────────────────────────────────────────────────────────────────
-- 3) Tabela treinamentos
-- ────────────────────────────────────────────────────────────────────────────
CREATE TYPE public.modalidade_treinamento AS ENUM ('presencial', 'ead');

CREATE TABLE IF NOT EXISTS public.treinamentos (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  empresa_id         UUID REFERENCES public.empresas(id),
  nome               TEXT NOT NULL,
  modalidade         modalidade_treinamento NOT NULL DEFAULT 'presencial',
  diaria_instrutor   NUMERIC(12,2),       -- null quando EAD
  valor_bruto        NUMERIC(12,2) NOT NULL DEFAULT 0,
  -- Comissão fixa de 7% sobre o valor bruto (generated)
  valor_comissao     NUMERIC(12,2) GENERATED ALWAYS AS (ROUND(valor_bruto * 0.07, 2)) STORED,
  data_treinamento   DATE NOT NULL,
  data_pagamento     DATE,
  observacoes        TEXT,
  criado_em          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_treinamentos_empresa  ON public.treinamentos(empresa_id);
CREATE INDEX IF NOT EXISTS idx_treinamentos_data     ON public.treinamentos(data_treinamento);

ALTER TABLE public.treinamentos ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read treinamentos"   ON public.treinamentos FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated users can insert treinamentos" ON public.treinamentos FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated users can update treinamentos" ON public.treinamentos FOR UPDATE TO authenticated USING (true);
CREATE POLICY "Authenticated users can delete treinamentos" ON public.treinamentos FOR DELETE TO authenticated USING (true);

-- ────────────────────────────────────────────────────────────────────────────
-- 4) Storage buckets (criados aqui pra Supabase declarar)
--    Os buckets em si são criados via API — deixamos policies preparadas.
-- ────────────────────────────────────────────────────────────────────────────
-- As policies abaixo assumem que os buckets 'contratos-credenciadas' e
-- 'tabelas-preco' serão criados pela UI ou CLI com acesso privado.
INSERT INTO storage.buckets (id, name, public)
VALUES
  ('contratos-credenciadas', 'contratos-credenciadas', false),
  ('tabelas-preco',          'tabelas-preco',          false)
ON CONFLICT (id) DO NOTHING;

CREATE POLICY "Authenticated users can read contratos-credenciadas"
  ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'contratos-credenciadas');

CREATE POLICY "Authenticated users can write contratos-credenciadas"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'contratos-credenciadas');

CREATE POLICY "Authenticated users can delete contratos-credenciadas"
  ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'contratos-credenciadas');

CREATE POLICY "Authenticated users can read tabelas-preco"
  ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'tabelas-preco');

CREATE POLICY "Authenticated users can write tabelas-preco"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'tabelas-preco');

CREATE POLICY "Authenticated users can delete tabelas-preco"
  ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'tabelas-preco');
