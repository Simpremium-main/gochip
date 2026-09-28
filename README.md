# GoChip

Cadastro do titular pelo próprio cliente quando o chip SimPremium chega — **chip físico ou eSIM**.
Os dados vão direto para o banco do **Pedido Central** (mesmo projeto Supabase).

## Fluxo

1. **Chip** — o cliente digita o ICCID (impresso no cartão do chip físico; no e-mail do eSIM).
   O GoChip procura o chip na `order_activations_master` do Pedido Central e descobre o pedido
   e se é físico ou virtual. Link direto: `/?iccid=8955...` (serve para QR code na embalagem).
2. **Dados** — nome completo, CPF (com dígito verificador), nascimento, telefone/WhatsApp,
   e-mail, data prevista de uso, observações e consentimento LGPD. Chip não encontrado em
   pedido também é aceito: o cliente escolhe o tipo, informa o nº do pedido se souber, e a
   equipe vincula depois.
3. **Pronto** — o cadastro é gravado no Pedido Central.

## O que é gravado no Pedido Central

| Onde | O quê |
|---|---|
| `chip_registrations` (tabela nova) | Uma linha por chip: ICCID, tipo, pedido/origem/item/unidade da mestre, dados do titular, status (`recebido` → `conferido` / `cancelado`), IP e data do consentimento |
| `order_crm_logs` | Linha `[GoChip]` no histórico do pedido (CPF mascarado), quando o chip tem pedido |
| `outgoing_webhook_configs` / `outgoing_webhook_logs` | Gatilho opcional `gochip_cadastro` para o Make.com (ex.: e-mail de confirmação). Sem URL cadastrada, nada é disparado |

Regras:
- Um cadastro ativo por chip (índice único em `iccid_key`). Reenvio enquanto `recebido`
  **atualiza** a linha; depois de `conferido` pela equipe, fica travado.
- O tipo do chip registrado no pedido prevalece sobre o que o cliente escolheu.
- Tudo é revalidado no servidor; a service role key nunca vai ao navegador.
- Limite de requisições por IP e campo-armadilha contra robôs.

## Instalação

1. Aplique `sql/2026-09-28_gochip_chip_registrations.sql` no SQL Editor do Supabase do Pedido
   Central (convenção do Pedido Central: DDL não é executado pelo app).
2. Copie `.env.example` para `.env.local` e preencha `NEXT_PUBLIC_SUPABASE_URL` e
   `SUPABASE_SERVICE_ROLE_KEY` (os mesmos do Pedido Central).
3. `npm install && npm run dev` → http://localhost:9010

Scripts: `npm test` (validações), `npm run typecheck`, `npm run build`.

## API

- `GET /api/chip?iccid=...` → `{ iccid, encontrado, tipo, pedidoFinal, jaCadastrado, bloqueado }`
  (só os 4 últimos dígitos do pedido; nenhum dado pessoal é exposto)
- `POST /api/cadastro` (JSON) → `{ success, id, atualizado, vinculadoAoPedido }`;
  `422` com `campos` por campo inválido, `409` se o cadastro já foi conferido.

## Stack

Next.js 15 (App Router) + TypeScript, Tailwind, Zod, Supabase — a mesma do Pedido Central.
