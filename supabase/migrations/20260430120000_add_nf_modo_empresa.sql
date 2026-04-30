-- Modo de emissão de NF por empresa: define o comportamento padrão no
-- formulário de faturar (em massa ou avulso) sem precisar marcar caso a caso.
--   nao_emite : empresa não recebe NF (checkbox desabilitado)
--   manual    : checkbox default desmarcado (user marca quando precisa)
--   automatica: checkbox default marcado (toda venda gera NF)
ALTER TABLE empresas
  ADD COLUMN IF NOT EXISTS nf_modo TEXT
  CHECK (nf_modo IN ('nao_emite', 'manual', 'automatica'));

-- Migra valores antigos: emitir_nf_padrao=true → automatica, senão manual
UPDATE empresas
SET nf_modo = CASE WHEN emitir_nf_padrao THEN 'automatica' ELSE 'manual' END
WHERE nf_modo IS NULL;
