import { z } from 'zod';
import { cpfValido, iccidValido, normalizarTelefone, soDigitos } from '@/lib/documentos';

const dataIso = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Data inválida')
  .refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)), 'Data inválida');

const opcional = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), schema.optional());

/**
 * O formulário, validado igual no navegador e no servidor.
 * O servidor NÃO confia no navegador: tudo é revalidado em /api/cadastro.
 */
export const cadastroSchema = z.object({
  iccid: z.string().trim().refine(iccidValido, 'ICCID inválido. Confira o número impresso no chip ou no e-mail do eSIM.'),
  chip_type: z.enum(['fisico', 'virtual']),
  full_name: z
    .string()
    .trim()
    .min(5, 'Informe o nome completo')
    .max(120)
    .refine((s) => s.split(/\s+/).length >= 2, 'Informe nome e sobrenome'),
  cpf: z.string().refine(cpfValido, 'CPF inválido').transform(soDigitos),
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
  order_number_informed: opcional(z.string().trim().max(40)),
  travel_start: opcional(dataIso),
  observation: opcional(z.string().trim().max(1000)),
  lgpd: z.literal(true, { errorMap: () => ({ message: 'É preciso aceitar o uso dos dados para a ativação' }) }),
  // Campo-armadilha para robôs: fica escondido na tela e precisa chegar vazio.
  website: opcional(z.string().max(0, 'Envio inválido')),
});

export type CadastroEntrada = z.input<typeof cadastroSchema>;
export type Cadastro = z.output<typeof cadastroSchema>;

export type TipoChip = 'fisico' | 'virtual';

/** Resposta de GET /api/chip — o mínimo para o cliente seguir, sem expor dados do pedido. */
export interface ConsultaChip {
  iccid: string;
  encontrado: boolean;
  tipo: TipoChip | null;
  /** Últimos dígitos do número do pedido, para o cliente reconhecer a compra. */
  pedidoFinal: string | null;
  /** Já existe cadastro ativo para este chip. */
  jaCadastrado: boolean;
  /** O cadastro existente já foi conferido pela equipe e não aceita mais alteração. */
  bloqueado: boolean;
}
