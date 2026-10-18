-- GoChip — ICCID só leitura: o número do chip é o que está no sistema (lançado pela equipe
-- na `order_activations_master`), e o cliente não digita mais.
--
-- Aplicar DEPOIS de 2026-10-18_gochip_varios_chips.sql, no SQL Editor do Supabase do Pedido
-- Central. É idempotente. OBRIGATÓRIO antes de publicar esta versão.
--
-- O que muda:
--   1. Chip físico ainda sem ICCID lançado pode ser cadastrado (a equipe lança depois): sai a
--      regra que exigia ICCID no chip físico.
--   2. Chip sem ICCID, físico ou eSIM, fica único por pedido + item + posição. Com ICCID,
--      continua único pelo ICCID (chip_registrations_iccid_ativo).

ALTER TABLE chip_registrations DROP CONSTRAINT IF EXISTS chip_registrations_iccid_fisico_chk;

DROP INDEX IF EXISTS chip_registrations_esim_pedido_chip_ativo;
CREATE UNIQUE INDEX IF NOT EXISTS chip_registrations_sem_iccid_chip_ativo
  ON chip_registrations (order_number, COALESCE(item_id, 0), COALESCE(unit_position, 1))
  WHERE iccid_key IS NULL AND order_number IS NOT NULL AND status <> 'cancelado';

-- Conferência: chips cadastrados que ainda aguardam o ICCID da equipe.
--   SELECT order_number, item_id, unit_position, chip_type, travel_start
--     FROM chip_registrations WHERE iccid_key IS NULL AND status <> 'cancelado' ORDER BY created_at DESC;
