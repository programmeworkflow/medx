-- Empresas que querem receber e-mail da venda automático após faturar.
-- Quando true, FaturarEmMassa dispara /api/contaazul/send-email-venda
-- após cada venda criada com sucesso (sem precisar marcar caso a caso).
ALTER TABLE empresas
  ADD COLUMN IF NOT EXISTS enviar_email_padrao BOOLEAN NOT NULL DEFAULT false;
