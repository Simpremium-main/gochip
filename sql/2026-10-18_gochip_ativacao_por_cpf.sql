-- GoChip — ativação a partir do CPF: o cliente informa só o CPF e escolhe, na lista, o
-- pedido do Mercado Livre ainda sem data de ativação.
--
-- Aplicar DEPOIS de 2026-09-29_gochip_mercado_livre_plano.sql, no SQL Editor do Supabase do
-- Pedido Central. É idempotente.
--
-- O que muda:
--   1. Como cada item do pedido aparece na lista, um pedido com dois eSIMs precisa aceitar
--      dois cadastros: o índice único do eSIM passa a ser por pedido + item.
--   2. Índices para listar os pedidos pelo CPF do comprador e achar os cadastros do pedido.

DROP INDEX IF EXISTS chip_registrations_esim_pedido_ativo;
CREATE UNIQUE INDEX IF NOT EXISTS chip_registrations_esim_pedido_item_ativo
  ON chip_registrations (order_number, COALESCE(item_id, 0))
  WHERE chip_type = 'virtual' AND iccid_key IS NULL AND order_number IS NOT NULL AND status <> 'cancelado';

CREATE INDEX IF NOT EXISTS chip_registrations_order_id_idx ON chip_registrations (order_id);
CREATE INDEX IF NOT EXISTS mercado_livre_orders_customer_cpf_idx ON mercado_livre_orders (customer_cpf);

-- Conferência:
--   SELECT order_number, item_id, count(*) FROM chip_registrations
--     WHERE chip_type = 'virtual' AND status <> 'cancelado' GROUP BY 1, 2 HAVING count(*) > 1;
