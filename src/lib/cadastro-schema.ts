import { z } from 'zod';
import { cpfValido, iccidValido, normalizarTelefone, soDigitos } from '@/lib/documentos';
import type { PlanoComprado } from '@/lib/plano';

const dataIso = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Data inválida')
  .refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)), 'Data inválida');

const opcional = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), schema.optional());

export const MSG_ICCID = 'ICCID inválido. Confira o número impresso no cartão do chip (18 a 22 dígitos, começa com 89).';

const cpf = z.string().refine(cpfValido, 'CPF inválido').transform(soDigitos);

/** O pedido escolhido na lista: PK de `mercado_livre_orders` e o item (quando há). */
const pedidoId = z.string().trim().regex(/^\d{1,20}$/, 'Selecione um pedido');
const itemId = z.preprocess((v) => (v === '' || v === undefined ? null : v), z.number().int().positive().nullable());

/** Passo 1: só o CPF da conta no Mercado Livre, para listar os pedidos a ativar. */
export const pedidosSchema = z.object({ cpf });

/** Passo 2: o pedido escolhido. O servidor confere de novo que ele é deste CPF. */
export const consultaSchema = z.object({ cpf, pedido_id: pedidoId, item_id: itemId });

/**
 * O formulário, validado igual no navegador e no servidor.
 * O servidor NÃO confia no navegador: tudo é revalidado em /api/cadastro; o tipo de chip,
 * o plano e os países permitidos são lidos de novo do pedido.
 */
export const cadastroSchema = z.object({
  pedido_id: pedidoId,
  item_id: itemId,
  /** Chip físico cujo ICCID ainda não foi lançado no pedido: o cliente digita. */
  iccid: opcional(z.string().trim().refine(iccidValido, MSG_ICCID)),
  full_name: z
    .string()
    .trim()
    .min(5, 'Informe o nome completo')
    .max(120)
    .refine((s) => s.split(/\s+/).length >= 2, 'Informe nome e sobrenome'),
  cpf,
  birth_date: opcional(
    dataIso.refine((s) => {
      const ano = Number(s.slice(0, 4));
      return ano >= 1900 && new Date(`${s}T00:00:00Z`) < new Date();
    }, 'Data de nascimento inválida'),
  ),
  email: z.string().trim().toLowerCase().email('E-mail inválido').max(160),
  phone: z
    .string()
    .refine((s) => normalizarTelefone(s) !== null, 'Telefone inválido — use DDD + número')
    .transform((s) => normalizarTelefone(s) as string),
  travel_start: z.string().min(1, 'Informe a data de ativação').pipe(dataIso),
  countries: z
    .array(z.string().trim().min(1).max(80))
    .min(1, 'Selecione os países que vai visitar')
    .max(80)
    .transform((l) => [...new Set(l)]),
  observation: opcional(z.string().trim().max(1000)),
  lgpd: z.literal(true, { errorMap: () => ({ message: 'É preciso aceitar o uso dos dados para a ativação' }) }),
  // Campo-armadilha para robôs: fica escondido na tela e precisa chegar vazio.
  website: opcional(z.string().max(0, 'Envio inválido')),
});

export type PedidosDados = z.output<typeof pedidosSchema>;
export type ConsultaEntrada = z.input<typeof consultaSchema>;
export type ConsultaDados = z.output<typeof consultaSchema>;
export type CadastroEntrada = z.input<typeof cadastroSchema>;
export type Cadastro = z.output<typeof cadastroSchema>;

export type TipoChip = 'fisico' | 'virtual';

/** Dados já conhecidos do titular e da ativação, para preencher o formulário. */
export interface Preenchimento {
  full_name: string;
  email: string;
  phone: string;
  birth_date: string;
  travel_start: string;
  countries: string[];
}

/** O que já foi cadastrado, para mostrar quando o cadastro está travado. */
export interface ResumoCadastro {
  plano: string | null;
  destino: string | null;
  dias: number | null;
  franquia: string | null;
  paises: string[];
  ativacao: string | null;
  fim: string | null;
}

/** Um pedido do CPF ainda sem data de ativação — uma linha da lista do passo 1. */
export interface PedidoPendente {
  pedido_id: string;
  item_id: number | null;
  /** Últimos dígitos do número do pedido, para o cliente reconhecer a compra. */
  pedidoFinal: string;
  titulo: string;
  tipo: TipoChip;
  /** Data da compra (aaaa-mm-dd). */
  compradoEm: string | null;
  destino: string | null;
  dias: number | null;
  franquia: string | null;
  /** Já houve um envio que parou no meio; o cliente só precisa concluir. */
  envioIncompleto: boolean;
}

/** Resposta de POST /api/pedidos. */
export interface ListaPedidos {
  pedidos: PedidoPendente[];
}

/** Resposta de POST /api/consulta. */
export interface Consulta {
  tipo: TipoChip;
  /** ICCID do chip físico já lançado no pedido. Nulo no físico = o cliente digita. */
  iccid: string | null;
  /** Últimos dígitos do número do pedido, para o cliente reconhecer a compra. */
  pedidoFinal: string | null;
  /** O plano comprado. Nulo quando o pedido não foi localizado. */
  plano: PlanoComprado | null;
  /** Dados do pedido (ou do envio que parou no meio) para preencher o formulário. */
  preenchimento: Preenchimento | null;
  /** Já existe cadastro ativo (envio incompleto) para este pedido. */
  jaCadastrado: boolean;
  /** Já existe cadastro enviado para este chip/pedido; não aceita mais alteração. */
  bloqueado: boolean;
  /** Resumo do cadastro travado. */
  resumo: ResumoCadastro | null;
}
