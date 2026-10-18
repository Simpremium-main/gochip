-- GoChip — pedido com mais de um chip: um cadastro (linha) por chip, com o mesmo titular.
--
-- Aplicar DEPOIS de 2026-10-18_gochip_ativacao_por_cpf.sql, no SQL Editor do Supabase do
-- Pedido Central. É idempotente. OBRIGATÓRIO antes de publicar esta versão: o GoChip grava
-- a coluna `unit_position`.
--
-- O que muda:
--   1. `unit_position`: qual chip do item é este (1, 2, 3… até a quantidade vendida). O
--      `unit_index` continua sendo o da mestre, quando a equipe já lançou o chip.
--   2. O índice único do eSIM passa a ser por pedido + item + chip, para um item com
--      quantidade 3 aceitar três cadastros. Cadastro antigo, sem posição, conta como o 1º.

ALTER TABLE chip_registrations ADD COLUMN IF NOT EXISTS unit_position integer;

DROP INDEX IF EXISTS chip_registrations_esim_pedido_ativo;
DROP INDEX IF EXISTS chip_registrations_esim_pedido_item_ativo;
CREATE UNIQUE INDEX IF NOT EXISTS chip_registrations_esim_pedido_chip_ativo
  ON chip_registrations (order_number, COALESCE(item_id, 0), COALESCE(unit_position, 1))
  WHERE chip_type = 'virtual' AND iccid_key IS NULL AND order_number IS NOT NULL AND status <> 'cancelado';

-- Conferência:
--   SELECT order_number, item_id, unit_position, chip_type, iccid_key, travel_start, countries
--     FROM chip_registrations WHERE status <> 'cancelado' ORDER BY created_at DESC LIMIT 20;
