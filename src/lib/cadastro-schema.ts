import { z } from 'zod';
import { cpfValido, normalizarTelefone, soDigitos } from '@/lib/documentos';
import type { PlanoComprado } from '@/lib/plano';

const dataIso = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Data inválida')
  .refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)), 'Data inválida');

const opcional = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), schema.optional());

const cpf = z.string().refine(cpfValido, 'CPF inválido').transform(soDigitos);

/** O pedido escolhido na lista: PK de `mercado_livre_orders`. */
const pedidoId = z.string().trim().regex(/^\d{1,20}$/, 'Selecione um pedido');
const itemId = z.preprocess((v) => (v === '' || v === undefined ? null : v), z.number().int().positive().nullable());

/** Passo 1: só o CPF da conta no Mercado Livre, para listar os pedidos a ativar. */
export const pedidosSchema = z.object({ cpf });

/** Passo 2: o pedido escolhido. O servidor confere de novo que ele é deste CPF. */
export const consultaSchema = z.object({ cpf, pedido_id: pedidoId });

/**
 * Um chip do pedido: o item (anúncio) e a posição dele dentro do item — um item com
 * quantidade 3 tem os chips 1, 2 e 3. Data de ativação e países são de cada chip.
 */
export const chipSchema = z.object({
  item_id: itemId,
  posicao: z.number().int().min(1).max(50),
  travel_start: z.string().min(1, 'Informe a data de ativação').pipe(dataIso),
  countries: z
    .array(z.string().trim().min(1).max(80))
    .min(1, 'Selecione os países que vai visitar')
    .max(80)
    .transform((l) => [...new Set(l)]),
});

/**
 * O formulário, validado igual no navegador e no servidor. Os dados pessoais são um só
 * titular para todos os chips do pedido.
 * O servidor NÃO confia no navegador: tudo é revalidado em /api/cadastro; o tipo de chip,
 * o plano e os países permitidos são lidos de novo do pedido.
 */
export const cadastroSchema = z.object({
  pedido_id: pedidoId,
  chips: z.array(chipSchema).min(1, 'Nenhum chip para cadastrar').max(50),
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
  observation: opcional(z.string().trim().max(1000)),
  lgpd: z.literal(true, { errorMap: () => ({ message: 'É preciso aceitar o uso dos dados para a ativação' }) }),
  // Campo-armadilha para robôs: fica escondido na tela e precisa chegar vazio.
  website: opcional(z.string().max(0, 'Envio inválido')),
});

/** Chave do erro de um campo: "email", ou "chips.1.countries" para o campo de um chip. */
export const chaveDoCampo = (path: (string | number)[]): string =>
  path[0] === 'chips' && path.length >= 3 ? `chips.${path[1]}.${path[2]}` : String(path[0] ?? '_');

export type PedidosDados = z.output<typeof pedidosSchema>;
export type ConsultaDados = z.output<typeof consultaSchema>;
export type CadastroEntrada = z.input<typeof cadastroSchema>;
export type Cadastro = z.output<typeof cadastroSchema>;
export type ChipCadastro = z.output<typeof chipSchema>;

export type TipoChip = 'fisico' | 'virtual';

/** Dados já conhecidos do titular, para preencher o formulário (valem para todos os chips). */
export interface Preenchimento {
  full_name: string;
  email: string;
  phone: string;
  birth_date: string;
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

/** Um pedido do CPF com chips ainda sem data de ativação — uma linha da lista do passo 1. */
export interface PedidoPendente {
  pedido_id: string;
  /** Últimos dígitos do número do pedido, para o cliente reconhecer a compra. */
  pedidoFinal: string;
  titulo: string;
  /** Tipos dos chips pendentes (um pedido pode ter físico e eSIM). */
  tipos: TipoChip[];
  /** Quantos chips do pedido ainda faltam ativar. */
  chips: number;
  /** Data da compra (aaaa-mm-dd). */
  compradoEm: string | null;
  destino: string | null;
  dias: number | null;
  franquia: string | null;
  /** Já houve um envio que parou no meio; o cliente só precisa concluir. */
  envioIncompleto: boolean;
}

/** Um pedido do CPF que já tem os dados de ativação enviados. */
export interface PedidoEnviado {
  pedido_id: string;
  pedidoFinal: string;
  titulo: string;
  tipos: TipoChip[];
  chips: number;
  compradoEm: string | null;
  destino: string | null;
  dias: number | null;
  franquia: string | null;
  /** Primeira data de ativação do pedido (lançada pela equipe ou enviada no GoChip). */
  ativacao: string | null;
}

/** Resposta de POST /api/pedidos. */
export interface ListaPedidos {
  /** O CPF tem algum pedido no Mercado Livre (pendente ou não). */
  cpfEncontrado: boolean;
  pedidos: PedidoPendente[];
  /** Sem nenhum pendente: os últimos 5 pedidos do CPF, todos com os dados já enviados. */
  recentes: PedidoEnviado[];
}

/** Um chip pendente do pedido, com o plano dele. */
export interface ChipConsulta {
  item_id: number | null;
  posicao: number;
  tipo: TipoChip;
  /** ICCID que está no sistema (só leitura na tela). Nulo = a equipe ainda não lançou. */
  iccid: string | null;
  plano: PlanoComprado | null;
  /** Data e países já conhecidos deste chip (envio que parou no meio ou o próprio pedido). */
  travel_start: string;
  countries: string[];
  /** Já existe cadastro ativo (envio incompleto) para este chip. */
  jaCadastrado: boolean;
}

/** Resposta de POST /api/consulta. */
export interface Consulta {
  /** Últimos dígitos do número do pedido, para o cliente reconhecer a compra. */
  pedidoFinal: string;
  /** Chips do pedido que ainda faltam cadastrar. Vazio quando o pedido está travado. */
  chips: ChipConsulta[];
  /** Chips deste pedido já cadastrados (não entram no formulário). */
  jaEnviados: number;
  /** Dados do titular para preencher o formulário. */
  preenchimento: Preenchimento | null;
  /** Todos os chips do pedido já têm cadastro enviado; não aceita mais alteração. */
  bloqueado: boolean;
  /** Resumo do cadastro travado. */
  resumo: ResumoCadastro | null;
}
