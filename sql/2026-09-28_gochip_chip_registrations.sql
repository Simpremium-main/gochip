-- GoChip — cadastro do titular feito pelo próprio cliente quando o chip chega.
--
-- Roda no MESMO projeto Supabase do Pedido Central. Segue a convenção de lá: DDL não é
-- executado pelo app, este arquivo é aplicado à mão no SQL Editor.
--
-- Uma linha é UM chip (físico ou virtual) cadastrado pelo cliente: o ICCID que ele digitou,
-- o pedido a que esse ICCID pertence na `order_activations_master` (quando existe) e os
-- dados do titular. O pedido fica nulo quando o ICCID ainda não foi lançado no pedido — o
-- cadastro não se perde, e a equipe vincula depois.

CREATE TABLE IF NOT EXISTS chip_registrations (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),

  -- Chip
  iccid          text NOT NULL,           -- como o cliente digitou
  iccid_key      text NOT NULL,           -- só letras e dígitos, em maiúsculas (mesma regra de chaveIccid)
  chip_type      text NOT NULL CHECK (chip_type IN ('fisico', 'virtual')),

  -- Pedido (da order_activations_master; nulo = chip ainda sem pedido conhecido)
  order_id       text,
  order_number   text,
  order_source   text,                    -- main, agency, distributor, mercadolivre…
  item_id        bigint,
  unit_index     integer,
  order_number_informed text,             -- número de pedido que o CLIENTE informou no formulário

  -- Titular
  full_name      text NOT NULL,
  cpf            text NOT NULL,           -- só dígitos
  birth_date     date,
  email          text NOT NULL,
  phone          text NOT NULL,           -- WhatsApp / telefone de contato, só dígitos com DDI
  travel_start   date,                    -- data prevista de início de uso
  observation    text,

  -- Fluxo interno
  status         text NOT NULL DEFAULT 'recebido'
                 CHECK (status IN ('recebido', 'conferido', 'cancelado')),
  reviewed_at    timestamptz,
  reviewed_by    text,
  lgpd_consent_at timestamptz NOT NULL,

  -- Auditoria da submissão
  submitted_ip   text,
  user_agent     text
);

-- Um cadastro ativo por chip. Reenvio do cliente atualiza a linha em vez de duplicar;
-- cadastro cancelado libera o ICCID para um novo.
CREATE UNIQUE INDEX IF NOT EXISTS chip_registrations_iccid_ativo
  ON chip_registrations (iccid_key)
  WHERE status <> 'cancelado';

CREATE INDEX IF NOT EXISTS chip_registrations_order   ON chip_registrations (order_source, order_id);
CREATE INDEX IF NOT EXISTS chip_registrations_cpf     ON chip_registrations (cpf);
CREATE INDEX IF NOT EXISTS chip_registrations_status  ON chip_registrations (status, created_at DESC);

-- Dados pessoais: sem política nenhuma, só a service role (servidor) lê e grava.
ALTER TABLE chip_registrations ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE chip_registrations IS
  'GoChip: dados do titular enviados pelo cliente ao receber o chip (físico ou eSIM).';

-- Opcional: gatilho de saída para o Make.com (e-mail de confirmação ao cliente, aviso à
-- equipe). Sem URL cadastrada o GoChip simplesmente não dispara nada.
--   INSERT INTO outgoing_webhook_configs (trigger_name, url, is_active)
--   VALUES ('gochip_cadastro', 'https://hook.make.com/...', true);

-- Conferência:
--   SELECT status, count(*) FROM chip_registrations GROUP BY 1;
--   SELECT * FROM chip_registrations WHERE order_id IS NULL AND status = 'recebido';
