-- GoChip — cadastro só de pedidos do Mercado Livre, com o plano comprado e os países.
--
-- Aplicar DEPOIS de 2026-09-28_gochip_chip_registrations.sql, no SQL Editor do Supabase do
-- Pedido Central. É idempotente.
--
-- O que muda:
--   1. eSIM não tem chip na mão: o cliente se identifica pelo número do pedido, então o
--      ICCID passa a ser opcional (continua obrigatório no chip físico).
--   2. O plano comprado (lido do anúncio vinculado na Tabela de Preço → Mercado Livre, ou do
--      título), os países escolhidos e o fim da vigência ficam gravados no cadastro.
--   3. `ml_submission_id` aponta para a linha de `mercado_livre_form_submissions` que o
--      GoChip gera — é por ela que a equipe faz a baixa em /mercado-livre/baixa-pedido,
--      como fazia com o formulário do site.

ALTER TABLE chip_registrations ALTER COLUMN iccid     DROP NOT NULL;
ALTER TABLE chip_registrations ALTER COLUMN iccid_key DROP NOT NULL;

ALTER TABLE chip_registrations DROP CONSTRAINT IF EXISTS chip_registrations_iccid_fisico_chk;
ALTER TABLE chip_registrations
  ADD CONSTRAINT chip_registrations_iccid_fisico_chk
  CHECK (chip_type = 'virtual' OR iccid_key IS NOT NULL);

ALTER TABLE chip_registrations ADD COLUMN IF NOT EXISTS travel_end       date;    -- último dia de uso (ativação + dias − 1)
ALTER TABLE chip_registrations ADD COLUMN IF NOT EXISTS countries        text;    -- países que o cliente vai visitar, separados por vírgula
ALTER TABLE chip_registrations ADD COLUMN IF NOT EXISTS plan_title       text;    -- título do produto no Mercado Livre
ALTER TABLE chip_registrations ADD COLUMN IF NOT EXISTS plan_destination text;    -- "Estados Unidos", "Europa"
ALTER TABLE chip_registrations ADD COLUMN IF NOT EXISTS plan_days        integer;
ALTER TABLE chip_registrations ADD COLUMN IF NOT EXISTS plan_data        text;    -- franquia: "3GB", "1GB/dia"
ALTER TABLE chip_registrations ADD COLUMN IF NOT EXISTS ml_submission_id bigint REFERENCES mercado_livre_form_submissions(id) ON DELETE SET NULL;

-- Um cadastro ativo por pedido de eSIM (o do chip físico continua sendo por ICCID).
CREATE UNIQUE INDEX IF NOT EXISTS chip_registrations_esim_pedido_ativo
  ON chip_registrations (order_number)
  WHERE chip_type = 'virtual' AND iccid_key IS NULL AND order_number IS NOT NULL AND status <> 'cancelado';

CREATE INDEX IF NOT EXISTS chip_registrations_submissao ON chip_registrations (ml_submission_id);

-- Leitura do pedido do eSIM pelo número do Mercado Livre.
CREATE INDEX IF NOT EXISTS mercado_livre_orders_order_id_idx ON mercado_livre_orders (order_id);

-- Conferência:
--   SELECT chip_type, count(*), count(ml_submission_id) FROM chip_registrations GROUP BY 1;
--   SELECT plan_title, plan_days, plan_data, countries, travel_start, travel_end
--     FROM chip_registrations ORDER BY created_at DESC LIMIT 20;
