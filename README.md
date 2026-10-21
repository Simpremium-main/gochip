# GoChip

Cadastro do titular pelo próprio cliente quando o chip chega — **chip físico ou eSIM**.
Os dados vão direto para o banco do **Pedido Central** (mesmo projeto Supabase).

## Fluxo

Só pedidos do **Mercado Livre**.

1. **Cadastro**: o cliente informa só o **CPF da conta no Mercado Livre**.
2. **Pedido**: a tela lista os pedidos desse CPF (`mercado_livre_orders.customer_cpf`) que
   ainda **não têm data de ativação** — nem no item do pedido (`mercado_livre_order_items.checkin`),
   nem num cadastro do GoChip já enviado. Cada pedido é uma linha, com quantos chips faltam, o tipo
   (chip físico ou eSIM, lido do título), final do número do pedido, plano e data da compra. O
   cliente escolhe um. Cada item do pedido vira tantos chips quanto a quantidade vendida.
   O servidor confere de novo, a cada passo, que o pedido escolhido é do CPF informado.
3. **Plano**: o GoChip pergunta à API do Mercado Livre qual anúncio (MLB) foi vendido e procura
   o plano vinculado a ele na Tabela de Preço → Mercado Livre (`system_settings.tabela_preco_ml_anuncios`),
   com dias, franquia e **países cobertos**. Sem vínculo, compara o título com o dos anúncios e,
   por último, lê o próprio título ("Chip Virtual Esim Estados Unidos 30 Dias 3gb" → Estados
   Unidos, 30 dias, 3GB), resolvendo os países pela Padronização de países.
4. **Dados**: nome, nascimento, telefone e e-mail — **um titular só para todos os chips do
   pedido** — e, de cada chip, **data de ativação** (a tela mostra "vale de
   10/10 até 08/11": o dia da ativação conta como o 1º) e **países que vai visitar**, só entre os
   que o plano cobre. Com mais de um chip, a caixa **"Usar a mesma data de ativação e os mesmos
   destinos para os N chips"** vem marcada: uma data e uma escolha de países valem para todos (só os
   países que todos os planos cobrem). Desmarcada, cada chip tem a sua. Os dados do comprador já vêm
   preenchidos. O **número do chip (ICCID) é só leitura**: a tela mostra o que está na
   `order_activations_master` (`source = 'mercado-livre'`), e o cliente não altera. No chip físico a
   ajuda diz que é o número impresso no cartão, abaixo do código de barras; no eSIM, que é o número
   que virá abaixo do QR code no e-mail. Se a equipe ainda não lançou, aparece "Será informado pela
   nossa equipe" e o cadastro segue sem ICCID.
5. **Pronto**: cada chip é gravado no Pedido Central (uma linha e uma submissão da baixa por chip)
   e entra na baixa do pedido.

CPF com pedidos, mas nenhum pendente: a tela mostra os **últimos 5 pedidos** com o aviso de que os
dados de ativação já foram enviados (e a data de ativação de cada um), mais o botão do WhatsApp do
suporte. "CPF não encontrado" só aparece quando o CPF não tem nenhum pedido no Mercado Livre.

## O que é gravado no Pedido Central

| Onde | O quê |
|---|---|
| `chip_registrations` | Uma linha por chip (pelo ICCID do sistema; sem ICCID, por pedido + item + posição `unit_position`): pedido, titular, plano (título, destino, dias, franquia), países, início e fim da vigência, consentimento LGPD |
| `mercado_livre_form_submissions` | A mesma submissão que o formulário do site gerava. **Substitui o formulário**: a equipe faz a baixa em `/mercado-livre/baixa-pedido` como sempre. Plano, ICCID e CPF do titular vão na observação |
| `order_crm_logs` | Linha `[GoChip]` no histórico do pedido (CPF mascarado) |
| `outgoing_webhook_configs` / `outgoing_webhook_logs` | Gatilho opcional `gochip_cadastro` para o Make.com, agora com plano, países e vigência |

Regras:
- Um cadastro ativo por chip: pelo ICCID quando ele já está no sistema; sem ICCID, por pedido + item + posição. **Depois de enviado, o cadastro
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
   `sql/2026-09-29_gochip_mercado_livre_plano.sql`, `sql/2026-10-18_gochip_ativacao_por_cpf.sql` e
   `sql/2026-10-18_gochip_varios_chips.sql` e `sql/2026-10-18_gochip_varios_chips_iccid.sql` no SQL Editor do Supabase do Pedido Central
   (convenção do Pedido Central: DDL não é executado pelo app).
2. Copie `.env.example` para `.env.local` e preencha `NEXT_PUBLIC_SUPABASE_URL` e
   `SUPABASE_SERVICE_ROLE_KEY` (os mesmos do Pedido Central).
3. `npm install && npm run dev` → http://localhost:9010/ativar (a raiz redireciona para a loja no Mercado Livre)

Scripts: `npm test` (validações), `npm run typecheck`, `npm run build`.

## API

- `POST /api/pedidos` `{ cpf }` → `{ cpfEncontrado, pedidos: [{ pedido_id, pedidoFinal, titulo, tipos, chips, compradoEm, destino, dias, franquia, envioIncompleto }], recentes: [{ …, ativacao }] }`
  (`recentes` = últimos 5 pedidos já enviados, só quando `pedidos` vem vazio)
- `POST /api/consulta` `{ cpf, pedido_id }` →
  `{ pedidoFinal, chips: [{ item_id, posicao, tipo, iccid, plano, travel_start, countries, jaCadastrado }], jaEnviados, preenchimento, bloqueado, resumo }`;
  `404` se o pedido não é do CPF ou já tem data de ativação
- `POST /api/cadastro` `{ cpf, pedido_id, chips: [{ item_id, posicao, travel_start, countries }], ...titular }` →
  `{ success, ids, vinculadoAoPedido, chips: [{ tipo, travel_start, vigenciaFim }] }`; o envio traz todos os
  chips pendentes do pedido. `422` com `campos` por campo inválido (`chips.1.countries` = países do 2º chip),
  `409` se já cadastrado, `404` se os chips do pedido mudaram.

## Stack

Next.js 15 (App Router) + TypeScript, Tailwind, Zod, Supabase — a mesma do Pedido Central.
