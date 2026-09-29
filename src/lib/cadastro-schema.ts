import { z } from 'zod';
import { cpfValido, iccidValido, normalizarTelefone, soDigitos } from '@/lib/documentos';
import type { PlanoComprado } from '@/lib/plano';

const dataIso = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Data inválida')
  .refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)), 'Data inválida');

const opcional = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), schema.optional());

const MSG_ICCID = 'ICCID inválido. Confira o número impresso no cartão do chip (18 a 22 dígitos, começa com 89).';
const MSG_PEDIDO = 'Informe o número do pedido do Mercado Livre';

/** Número do pedido do Mercado Livre: só dígitos, como aparece em "Minhas compras". */
const numeroPedido = z
  .string()
  .transform(soDigitos)
  .refine((s) => s.length >= 6 && s.length <= 20, 'Número do pedido inválido');

const cpf = z.string().refine(cpfValido, 'CPF inválido').transform(soDigitos);

/**
 * Chip físico se identifica pelo ICCID impresso no cartão; eSIM não tem chip na mão,
 * então se identifica pelo número do pedido do Mercado Livre.
 */
function exigirIdentificacao(
  v: { chip_type: 'fisico' | 'virtual'; iccid?: string; order_number?: string },
  ctx: z.RefinementCtx,
) {
  if (v.chip_type === 'fisico' && !iccidValido(v.iccid)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['iccid'], message: MSG_ICCID });
  }
  if (v.chip_type === 'virtual' && !v.order_number) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['order_number'], message: MSG_PEDIDO });
  }
}

/** Passo 1: o que o cliente tem na mão para achar a compra, mais o CPF de quem vai usar. */
export const consultaSchema = z
  .object({
    chip_type: z.enum(['fisico', 'virtual']),
    iccid: opcional(z.string().trim()),
    order_number: opcional(numeroPedido),
    cpf,
  })
  .superRefine(exigirIdentificacao);

/**
 * O formulário, validado igual no navegador e no servidor.
 * O servidor NÃO confia no navegador: tudo é revalidado em /api/cadastro, e o plano e os
 * países permitidos são lidos de novo do pedido.
 */
export const cadastroSchema = z
  .object({
    chip_type: z.enum(['fisico', 'virtual']),
    iccid: opcional(z.string().trim()),
    order_number: opcional(numeroPedido),
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
  })
  .superRefine(exigirIdentificacao);

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

/** Resposta de POST /api/consulta. */
export interface Consulta {
  tipo: TipoChip;
  /** ICCID normalizado (chip físico). */
  iccid: string | null;
  /** A compra foi localizada nos pedidos do Mercado Livre. */
  encontrado: boolean;
  /** Últimos dígitos do número do pedido, para o cliente reconhecer a compra. */
  pedidoFinal: string | null;
  /** O plano comprado. Nulo quando o pedido não foi localizado. */
  plano: PlanoComprado | null;
  /**
   * Dados do pedido para preencher o formulário. Só vem quando o CPF informado é o do
   * comprador (ou o de um cadastro já feito para este chip): ICCID e número de pedido
   * são sequenciais, e sem essa conferência qualquer um veria os dados de outro cliente.
   */
  preenchimento: Preenchimento | null;
  /** Já existe cadastro ativo para este chip/pedido. */
  jaCadastrado: boolean;
  /** O cadastro existente já foi conferido pela equipe e não aceita mais alteração. */
  bloqueado: boolean;
}
