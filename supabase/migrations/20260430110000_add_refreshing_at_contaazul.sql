-- Lock distribuído pra evitar refresh paralelo do OAuth2 da Conta Azul.
-- Sem isso, AWS Cognito (que a CA usa) detecta uso paralelo do mesmo
-- refresh_token como reuse attack e revoga TODOS os tokens do user.
ALTER TABLE contaazul_tokens
  ADD COLUMN IF NOT EXISTS refreshing_at TIMESTAMPTZ;
