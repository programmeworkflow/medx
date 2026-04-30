-- Status pra faturamento que tentou ir pra Conta Azul mas falhou
-- (erro de cadastro, NF, boleto ou auth). Usado pelo FaturarEmMassa
-- pra deixar a linha em vermelho na página Faturamento.
ALTER TYPE public.status_faturamento ADD VALUE IF NOT EXISTS 'ca_error';
