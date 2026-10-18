# GoChip

Cadastro do titular pelo próprio cliente quando o chip chega — **chip físico ou eSIM**.
Os dados vão direto para o banco do **Pedido Central** (mesmo projeto Supabase).

## Fluxo

Só pedidos do **Mercado Livre**.

1. **Cadastro**: o cliente informa só o **CPF da conta no Mercado Livre**.
2. **Pedido**: a tela lista os pedidos desse CPF (`mercado_livre_orders.customer_cpf`) que
   ainda **não têm data de ativação** — nem no item do pedido (`mercado_livre_order_items.checkin`),
   nem num cadastro do GoChip já enviado. Cada item do pedido é uma linha, com tipo (chip físico ou
   eSIM, lido do título), final do número do pedido, plano e data da compra. O cliente escolhe um.
   O servidor confere de novo, a cada passo, que o pedido escolhido é do CPF informado.
3. **Plano**: o GoChip pergunta à API do Mercado Livre qual anúncio (MLB) foi vendido e procura
   o plano vinculado a ele na Tabela de Preço → Mercado Livre (`system_settings.tabela_preco_ml_anuncios`),
   com dias, franquia e **países cobertos**. Sem vínculo, compara o título com o dos anúncios e,
   por último, lê o próprio título ("Chip Virtual Esim Estados Unidos 30 Dias 3gb" → Estados
   Unidos, 30 dias, 3GB), resolvendo os países pela Padronização de países.
4. **Dados**: nome, nascimento, telefone, e-mail, **data de ativação** (a tela mostra "vale de
   10/10 até 08/11": o dia da ativação conta como o 1º) e **países que vai visitar**, só entre os
   que o plano cobre. Os dados do comprador já vêm preenchidos. No chip físico, o ICCID vem da
   `order_activations_master` (`source = 'mercado-livre'`); se a equipe ainda não lançou, o
   cliente digita o número impresso no cartão.
5. **Pronto**: o cadastro é gravado no Pedido Central e entra na baixa do pedido.

CPF sem pedido pendente: a tela mostra o botão do WhatsApp do suporte.

## O que é gravado no Pedido Central

| Onde | O quê |
|---|---|
| `chip_registrations` | Uma linha por chip físico (ICCID) ou por pedido de eSIM: pedido, titular, plano (título, destino, dias, franquia), países, início e fim da vigência, consentimento LGPD |
| `mercado_livre_form_submissions` | A mesma submissão que o formulário do site gerava. **Substitui o formulário**: a equipe faz a baixa em `/mercado-livre/baixa-pedido` como sempre. Plano, ICCID e CPF do titular vão na observação |
| `order_crm_logs` | Linha `[GoChip]` no histórico do pedido (CPF mascarado) |
| `outgoing_webhook_configs` / `outgoing_webhook_logs` | Gatilho opcional `gochip_cadastro` para o Make.com, agora com plano, países e vigência |

Regras:
- Um cadastro ativo por chip físico (ICCID) e por item de pedido de eSIM. **Depois de enviado, o cadastro
  não pode ser alterado pela tela**: o cliente vê "Cadastro já realizado" e um botão para o
  WhatsApp do suporte (`WHATSAPP_SUPORTE`), com o chip/pedido já na mensagem. A equipe corrige
  pela baixa do pedido ou cancelando o cadastro (`status = 'cancelado'`), o que libera um novo
  envio. Exceção: envio que parou antes de gravar a submissão da baixa pode ser concluído.
- Os países escolhidos são conferidos no servidor contra a cobertura do plano.
- A API do ML usa a conta conectada no Pedido Central. O refresh token do ML é de uso único: o
  GoChip grava o par novo antes de usar e, se perder a corrida para o Pedido Central, relê o banco.
  Com a API fora do ar, o plano sai pelo título.
- Tudo é revalidado no servidor; a service role key nunca vai ao navegador.
- Limite de requisições por IP e campo-armadilha contra robôs.

## Instalação

1. Aplique, nesta ordem, `sql/2026-09-28_gochip_chip_registrations.sql`,
   `sql/2026-09-29_gochip_mercado_livre_plano.sql` e `sql/2026-10-18_gochip_ativacao_por_cpf.sql` no SQL Editor do Supabase do Pedido Central
   (convenção do Pedido Central: DDL não é executado pelo app).
2. Copie `.env.example` para `.env.local` e preencha `NEXT_PUBLIC_SUPABASE_URL` e
   `SUPABASE_SERVICE_ROLE_KEY` (os mesmos do Pedido Central).
3. `npm install && npm run dev` → http://localhost:9010

Scripts: `npm test` (validações), `npm run typecheck`, `npm run build`.

## API

- `POST /api/pedidos` `{ cpf }` → `{ pedidos: [{ pedido_id, item_id, pedidoFinal, titulo, tipo, compradoEm, destino, dias, franquia, envioIncompleto }] }`
- `POST /api/consulta` `{ cpf, pedido_id, item_id }` →
  `{ tipo, iccid, pedidoFinal, plano, preenchimento, jaCadastrado, bloqueado, resumo }`;
  `404` se o pedido não é do CPF ou já tem data de ativação
- `POST /api/cadastro` `{ cpf, pedido_id, item_id, iccid?, ...dados }` → `{ success, id, vinculadoAoPedido, vigenciaFim }`;
  `422` com `campos` por campo inválido (inclusive país fora do plano), `409` se já cadastrado.

## Stack

Next.js 15 (App Router) + TypeScript, Tailwind, Zod, Supabase — a mesma do Pedido Central.
