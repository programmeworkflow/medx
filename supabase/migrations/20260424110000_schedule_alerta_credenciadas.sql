-- ============================================================================
-- pg_cron: agenda a Edge Function alerta-credenciadas para rodar 08h BRT
-- todos os dias úteis (seg-sex) via HTTP POST.
--
-- Requisitos:
--  - Extensão pg_cron habilitada (Supabase habilita por default em planos pagos;
--    em plano Free, agendar manualmente via Dashboard > Database > Cron).
--  - Extensão pg_net habilitada (para net.http_post).
--
-- Se tu estiveres em plano Free, ignora essa migration e cria o schedule pela
-- UI em Database → Cron Jobs. A função em si continua funcionando.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- Troque 'https://<project-ref>.supabase.co' pela URL do teu projeto quando
-- rodar a migration. O Supabase expõe isso em settings → API.
DO $$
DECLARE
  project_url TEXT := current_setting('app.settings.project_url', true);
BEGIN
  -- Silencia se o setting não existir — o usuário cria o schedule pela UI
  -- quando rodar em produção.
  IF project_url IS NULL OR project_url = '' THEN
    RAISE NOTICE 'app.settings.project_url não definido — pule este cron e crie via Dashboard.';
    RETURN;
  END IF;

  PERFORM cron.schedule(
    'alerta-credenciadas-diario',
    '0 11 * * 1-5',  -- 11:00 UTC = 08:00 BRT, segunda a sexta
    format($cmd$
      SELECT net.http_post(
        url := %L,
        headers := jsonb_build_object(
          'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key'),
          'Content-Type', 'application/json'
        ),
        body := '{}'::jsonb
      );
    $cmd$, project_url || '/functions/v1/alerta-credenciadas')
  );
END $$;
