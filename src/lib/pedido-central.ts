import 'server-only';
import { supabaseServer } from '@/lib/supabase-server';
import { chaveIccid, formatarCpf, iccidValido, mascararCpf, soDigitos } from '@/lib/documentos';
import { itensDoPedidoML, type ItemVendido } from '@/lib/mercado-livre';
import {
  chaveTexto, fimDaVigencia, formatarFranquia, lerTitulo, paisesDaLista, tipoDoTitulo, type PlanoComprado,
} from '@/lib/plano';
import {
  MSG_ICCID,
  type Cadastro, type Consulta, type ConsultaDados, type ListaPedidos, type PedidoPendente, type PedidosDados,
  type TipoChip,
} from '@/lib/cadastro-schema';

/**
 * Integração com o banco do Pedido Central — só pedidos do MERCADO LIVRE.
 *
 * Lê:
 *   - `mercado_livre_orders` / `mercado_livre_order_items`: os pedidos do CPF do comprador,
 *     o título e a data de ativação já lançada (`checkin`);
 *   - `order_activations_master` (source = 'mercado-livre'): o ICCID do chip físico do pedido;
 *   - `system_settings.tabela_preco_ml_anuncios`: o vínculo anúncio (MLB) → plano, com a
 *     cobertura, feito na Tabela de Preço → Mercado Livre;
 *   - `price_table_countries` / `price_table_country_aliases`: países padronizados, para
 *     quando o anúncio não está vinculado e só o título diz o destino.
 * Grava:
 *   - `chip_registrations`: o cadastro do titular (registro do GoChip);
 *   - `mercado_livre_form_submissions`: a mesma submissão que o formulário do site gerava,
 *     para a equipe fazer a baixa em /mercado-livre/baixa-pedido como sempre;
 *   - `order_crm_logs` e, se configurado, o gatilho `gochip_cadastro`.
 */

const TABELA = 'chip_registrations';
const SUBMISSOES = 'mercado_livre_form_submissions';
const ORIGEM = 'mercado-livre';
const GATILHO = 'gochip_cadastro';
const SETTING_ANUNCIOS_ML = 'tabela_preco_ml_anuncios';

export class CadastroBloqueadoError extends Error {}

/** Pedido que não é do CPF, não existe mais ou já tem data de ativação. */
export class PedidoIndisponivelError extends Error {}

/** Campo que passou no formato mas não bate com o pedido (ex.: país fora do plano). */
export class CampoInvalidoError extends Error {
  constructor(public campos: Record<string, string>) {
    super('Confira os campos destacados.');
  }
}

// ---------------------------------------------------------------------------------------
// Pedido do Mercado Livre
// ---------------------------------------------------------------------------------------

/** Um chip do pedido: uma unidade de um item (anúncio) vendido. */
export interface ChipML {
  item_id: number | null;
  /** 1, 2, 3… dentro do item: um item com quantidade 3 tem três chips. */
  posicao: number;
  /** `unit_index` da linha da mestre deste chip, quando a equipe já lançou. */
  unit_index: number | null;
  titulo: string;
  tipo: TipoChip;
  /** ICCID do chip físico lançado na mestre; nulo se ainda não lançado. */
  iccid: string | null;
  /** Dados da ativação já lançados no item (de um formulário anterior ou da equipe). */
  checkin: string | null;
  destino: string | null;
}

export interface PedidoML {
  /** PK interna de `mercado_livre_orders` — é o `order_id` da mestre e do CRM. */
  id: string;
  /** Número do pedido no Mercado Livre. */
  numero: string;
  titulo: string;
  customer_name: string | null;
  customer_cpf: string | null;
  customer_email: string | null;
  customer_phone: string | null;
  chips: ChipML[];
}

const COLUNAS_PEDIDO = 'id, order_id, plan_name, customer_name, customer_cpf, customer_email, customer_phone, confirmation_status, created_at';
const MAX_CHIPS_POR_ITEM = 20;

/** O CPF pode estar gravado no pedido só com dígitos ou formatado. */
const grafiasCpf = (cpf: string) => [...new Set([cpf, formatarCpf(cpf)])];

/**
 * Itens do pedido (um por anúncio vendido). `select('*')` porque o nome da coluna de
 * quantidade e de título do item não é o mesmo em todos os lançamentos.
 */
async function itensDosPedidos(ids: string[]): Promise<any[]> {
  if (ids.length === 0) return [];
  const { data, error } = await supabaseServer.from('mercado_livre_order_items').select('*').in('order_id', ids).order('id');
  if (error) throw new Error(`Pedido Central indisponível: ${error.message}`);
  return (data || []) as any[];
}

const quantidadeDoItem = (item: any): number => {
  const q = Math.trunc(Number(item?.quantity ?? item?.qty ?? item?.quantidade ?? 1));
  return Number.isFinite(q) && q >= 1 ? Math.min(q, MAX_CHIPS_POR_ITEM) : 1;
};

/**
 * Os chips do pedido: cada item vira tantos chips quanto a quantidade vendida. As linhas
 * da mestre do item (ICCID lançado pela equipe) são distribuídas pela ordem do `unit_index`.
 */
function chipsDoPedido(pedido: any, itens: any[], mestre: any[]): ChipML[] {
  const id = String(pedido.id);
  const doPedido = itens.filter((i) => String(i.order_id) === id);
  // Pedido sem item lançado ainda conta como um chip a ativar.
  const unidades = doPedido.length ? doPedido : [{ id: null }];
  const chips: ChipML[] = [];
  for (const item of unidades) {
    const itemId = item.id == null ? null : Number(item.id);
    const titulo = String(item.plan_name ?? item.title ?? item.item_title ?? pedido.plan_name ?? '');
    // Linha da mestre sem item só vale quando o pedido tem um item só.
    const linhas = mestre
      .filter((m) => String(m.order_id) === id && (itemId == null || Number(m.item_id) === itemId || (m.item_id == null && unidades.length === 1)))
      .sort((a, b) => Number(a.unit_index ?? 0) - Number(b.unit_index ?? 0));
    const quantidade = Math.max(quantidadeDoItem(item), Math.min(linhas.length, MAX_CHIPS_POR_ITEM));
    for (let posicao = 1; posicao <= quantidade; posicao++) {
      const ativacao = linhas[posicao - 1];
      chips.push({
        item_id: itemId,
        posicao,
        unit_index: ativacao?.unit_index ?? null,
        titulo,
        tipo: tipoDoTitulo(titulo),
        iccid: ativacao?.iccid && iccidValido(ativacao.iccid) ? chaveIccid(ativacao.iccid) : null,
        checkin: item.checkin ? String(item.checkin).slice(0, 10) : null,
        destino: item.destino ?? null,
      });
    }
  }
  return chips;
}

/** Linhas da mestre (ICCIDs lançados) destes pedidos. */
async function mestreDosPedidos(ids: string[]): Promise<any[]> {
  if (ids.length === 0) return [];
  const { data, error } = await supabaseServer
    .from('order_activations_master')
    .select('order_id, iccid, item_id, unit_index, date_created')
    .eq('source', ORIGEM)
    .in('order_id', ids);
  if (error) throw new Error(`Pedido Central indisponível: ${error.message}`);
  return (data || []) as any[];
}

/** Cadastros ativos do GoChip para estes pedidos. */
async function cadastrosDosPedidos(ids: string[]): Promise<any[]> {
  if (ids.length === 0) return [];
  const { data, error } = await supabaseServer
    .from(TABELA)
    .select('*')
    .in('order_id', ids)
    .neq('status', 'cancelado')
    .order('created_at', { ascending: false });
  if (error) throw new Error(`Falha ao consultar cadastros: ${error.message}`);
  return (data || []) as any[];
}

/**
 * O cadastro de um chip: o do mesmo item e posição (cadastro antigo, sem posição, é o
 * do 1º chip) ou, no físico, o do mesmo ICCID.
 */
function cadastroDoChip(cadastros: any[], pedidoId: string, chip: ChipML) {
  return (
    cadastros.find(
      (c) =>
        String(c.order_id) === pedidoId &&
        (chip.item_id == null || c.item_id == null || Number(c.item_id) === chip.item_id) &&
        Number(c.unit_position ?? 1) === chip.posicao,
    ) ??
    (chip.iccid ? cadastros.find((c) => c.iccid_key === chip.iccid) : null) ??
    null
  );
}

/** Chip que ainda falta cadastrar: sem data no pedido e sem cadastro já enviado. */
const chipPendente = (chip: ChipML, cadastro: any) => !chip.checkin && !estaBloqueado(cadastro);

/**
 * Passo 1: os pedidos do Mercado Livre deste CPF com chips que ainda não têm data de
 * ativação — nem no item do pedido (`checkin`), nem num cadastro do GoChip já enviado.
 */
export async function pedidosPendentes(dados: PedidosDados): Promise<ListaPedidos> {
  const { data, error } = await supabaseServer
    .from('mercado_livre_orders')
    .select(COLUNAS_PEDIDO)
    .in('customer_cpf', grafiasCpf(dados.cpf))
    .neq('confirmation_status', 'rejected')
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) throw new Error(`Pedido Central indisponível: ${error.message}`);
  const pedidos = (data || []) as any[];
  const ids = pedidos.map((p) => String(p.id));
  const [itens, mestre, cadastros] = await Promise.all([itensDosPedidos(ids), mestreDosPedidos(ids), cadastrosDosPedidos(ids)]);

  const lista: PedidoPendente[] = [];
  for (const p of pedidos) {
    const id = String(p.id);
    const pendentes = chipsDoPedido(p, itens, mestre)
      .map((chip) => ({ chip, cadastro: cadastroDoChip(cadastros, id, chip) }))
      .filter(({ chip, cadastro }) => chipPendente(chip, cadastro));
    if (pendentes.length === 0) continue;
    const lido = lerTitulo(pendentes[0].chip.titulo || String(p.plan_name || ''));
    lista.push({
      pedido_id: id,
      pedidoFinal: String(p.order_id).slice(-4),
      titulo: lido.titulo,
      tipos: [...new Set(pendentes.map(({ chip }) => chip.tipo))],
      chips: pendentes.length,
      compradoEm: p.created_at ? String(p.created_at).slice(0, 10) : null,
      destino: lido.destino,
      dias: lido.dias,
      franquia: lido.franquia,
      envioIncompleto: pendentes.some(({ cadastro }) => !!cadastro),
    });
  }
  return { pedidos: lista };
}

/**
 * O pedido escolhido na lista, conferindo de novo que ele é do CPF informado: o navegador
 * só manda a referência, e quem decide de quem é o pedido é o servidor.
 */
export async function pedidoDoCpf(cpf: string, pedidoId: string): Promise<PedidoML | null> {
  const { data, error } = await supabaseServer
    .from('mercado_livre_orders')
    .select(COLUNAS_PEDIDO)
    .eq('id', pedidoId)
    .neq('confirmation_status', 'rejected')
    .limit(1);
  if (error) throw new Error(`Pedido Central indisponível: ${error.message}`);
  const p = (data || [])[0] as any;
  if (!p || soDigitos(p.customer_cpf) !== cpf) return null;

  const [itens, mestre] = await Promise.all([itensDosPedidos([String(p.id)]), mestreDosPedidos([String(p.id)])]);
  return {
    id: String(p.id),
    numero: String(p.order_id),
    titulo: String(p.plan_name || ''),
    customer_name: p.customer_name ?? null,
    customer_cpf: p.customer_cpf ?? null,
    customer_email: p.customer_email ?? null,
    customer_phone: p.customer_phone ?? null,
    chips: chipsDoPedido(p, itens, mestre),
  };
}

// ---------------------------------------------------------------------------------------
// Plano comprado
// ---------------------------------------------------------------------------------------

interface AnuncioML {
  ml_item_id: string | null;
  titulo: string;
  countries: string | null;
  franquia: string | null;
  por_dia?: boolean;
  dias: number;
}

interface Catalogo {
  anuncios: AnuncioML[];
  /** Nome ou apelido (chaveTexto) → países padronizados. */
  paises: Map<string, string[]>;
}

let cache: { em: number; valor: Promise<Catalogo> } | null = null;
const CACHE_MS = 5 * 60_000;

/** Anúncios vinculados e países padronizados, com cache curto (mudam pouco). */
function catalogo(): Promise<Catalogo> {
  if (cache && Date.now() - cache.em < CACHE_MS) return cache.valor;
  const valor = (async (): Promise<Catalogo> => {
    const [anuncios, paises, apelidos] = await Promise.all([
      supabaseServer.from('system_settings').select('value').eq('id', SETTING_ANUNCIOS_ML).maybeSingle(),
      supabaseServer.from('price_table_countries').select('id, name'),
      supabaseServer
        .from('price_table_country_aliases')
        .select('alias, country_id, countries')
        .is('operator', null)
        .is('plan_name', null),
    ]);

    let bruto: any = (anuncios.data as any)?.value;
    if (typeof bruto === 'string') {
      try { bruto = JSON.parse(bruto); } catch { bruto = null; }
    }
    const lista: AnuncioML[] = (Array.isArray(bruto) ? bruto : bruto?.anuncios) || [];

    const mapa = new Map<string, string[]>();
    const nomePorId = new Map<number, string>();
    for (const p of (paises.data || []) as any[]) {
      nomePorId.set(Number(p.id), p.name);
      mapa.set(chaveTexto(p.name), [p.name]);
    }
    for (const a of (apelidos.data || []) as any[]) {
      const alvo = a.countries ? paisesDaLista(a.countries) : nomePorId.has(Number(a.country_id)) ? [nomePorId.get(Number(a.country_id))!] : [];
      if (alvo.length && !mapa.has(chaveTexto(a.alias))) mapa.set(chaveTexto(a.alias), alvo);
    }
    return { anuncios: lista, paises: mapa };
  })();
  cache = { em: Date.now(), valor };
  valor.catch(() => { cache = null; });
  return valor;
}

/**
 * Países de um destino escrito no título ("Estados Unidos", "Europa + Turquia"). Só
 * devolve lista quando TODAS as partes são países ou apelidos conhecidos — metade da
 * cobertura seria pior que nenhuma, porque o cliente ficaria impedido de escolher o resto.
 */
function paisesDoDestino(destino: string | null, mapa: Map<string, string[]>): string[] {
  if (!destino) return [];
  const partes = destino.split(/\s*(?:\+|,|\/|\be\b)\s*/i).map(chaveTexto).filter(Boolean);
  const resultado: string[] = [];
  for (const parte of partes) {
    const paises = mapa.get(parte);
    if (!paises) return [];
    resultado.push(...paises);
  }
  return [...new Set(resultado)];
}

/**
 * O plano de cada título vendido no pedido (um pedido pode ter anúncios diferentes).
 *
 * 1. Pergunta ao Mercado Livre qual anúncio (MLB) foi vendido e procura o plano vinculado a
 *    ele na Tabela de Preço — é o caminho que não depende do título.
 * 2. Sem API ou sem vínculo pelo MLB, compara o título com o dos anúncios.
 * 3. Sem nenhum vínculo, lê o próprio título (destino, dias, franquia) e resolve os países
 *    pelo cadastro de países padronizados.
 */
export async function planosDoPedido(pedido: PedidoML): Promise<Map<string, PlanoComprado | null>> {
  const { anuncios, paises } = await catalogo();

  let itens: ItemVendido[] = [];
  try {
    itens = await itensDoPedidoML(pedido.numero);
  } catch (e) {
    console.error('[gochip] pedido não consultado no Mercado Livre:', (e as Error).message);
  }

  const planos = new Map<string, PlanoComprado | null>();
  for (const tituloChip of new Set(pedido.chips.map((c) => c.titulo || pedido.titulo))) {
    const chave = chaveTexto(tituloChip);
    const item = itens.find((i) => chaveTexto(i.titulo) === chave) || (itens.length === 1 ? itens[0] : null);
    const titulo = tituloChip || item?.titulo || '';
    if (!titulo) {
      planos.set(tituloChip, null);
      continue;
    }

    const anuncio =
      (item && anuncios.find((a) => a.ml_item_id && String(a.ml_item_id) === item.itemId)) ||
      anuncios.find((a) => {
        const t = chaveTexto(a.titulo);
        return !!t && (t === chave || (!!item && t === chaveTexto(item.titulo)));
      }) ||
      null;

    const lido = lerTitulo(titulo);
    if (anuncio) {
      const cobertura = paisesDaLista(anuncio.countries);
      planos.set(tituloChip, {
        titulo: lido.titulo,
        destino: lido.destino || (cobertura.length === 1 ? cobertura[0] : null),
        dias: Number(anuncio.dias) || lido.dias,
        franquia: formatarFranquia(anuncio.franquia, !!anuncio.por_dia) || lido.franquia,
        paises: cobertura,
        origem: 'anuncio',
      });
    } else {
      planos.set(tituloChip, { ...lido, paises: paisesDoDestino(lido.destino, paises), origem: 'titulo' });
    }
  }
  return planos;
}

const planoDoChip = (planos: Map<string, PlanoComprado | null>, pedido: PedidoML, chip: ChipML) =>
  planos.get(chip.titulo || pedido.titulo) ?? null;

// ---------------------------------------------------------------------------------------
// Cadastro
// ---------------------------------------------------------------------------------------

/**
 * Cadastros ativos dos chips do pedido: os gravados com o pedido e os dos ICCIDs já
 * lançados (o ICCID é único entre os cadastros ativos).
 */
async function cadastrosDoPedido(pedido: PedidoML): Promise<any[]> {
  const iccids = pedido.chips.map((c) => c.iccid).filter((i): i is string => !!i);
  const [doPedido, porIccid] = await Promise.all([cadastrosDosPedidos([pedido.id]), cadastrosDosIccids(iccids)]);
  const vistos = new Set(doPedido.map((c) => c.id));
  return [...doPedido, ...porIccid.filter((c) => !vistos.has(c.id))];
}

async function cadastrosDosIccids(iccids: string[]): Promise<any[]> {
  if (iccids.length === 0) return [];
  const { data, error } = await supabaseServer.from(TABELA).select('*').in('iccid_key', iccids).neq('status', 'cancelado');
  if (error) throw new Error(`Falha ao consultar cadastros: ${error.message}`);
  return (data || []) as any[];
}

/**
 * Cadastro enviado não se altera pela tela: qualquer correção passa pelo suporte.
 *
 * A única exceção é o envio que parou no meio — o cadastro foi gravado, mas a submissão da
 * baixa não (falha de rede, banco fora). Sem a submissão a equipe nem vê o cadastro, então
 * o cliente pode concluir o envio. Conferido pela equipe fica travado sempre.
 */
function estaBloqueado(existente: any): boolean {
  if (!existente) return false;
  return existente.status === 'conferido' || !!existente.ml_submission_id;
}

const MSG_BLOQUEADO =
  'Os chips deste pedido já foram cadastrados e os dados não podem mais ser alterados por aqui. Para corrigir algo, fale com o suporte.';

const MSG_NAO_ENCONTRADO = 'Não encontramos este pedido no seu CPF. Volte e escolha um pedido da lista.';
const MSG_JA_ATIVADO = 'Este pedido já tem data de ativação. Para alterar, fale com o suporte.';
const MSG_LISTA_MUDOU = 'Os chips deste pedido mudaram desde que você abriu a tela. Volte e escolha o pedido de novo.';

function telefoneParaTela(v: string | null | undefined): string {
  const d = soDigitos(v);
  return d ? `+${d.length === 10 || d.length === 11 ? `55${d}` : d}` : '';
}

/** Mantém só os países que o plano cobre, na grafia do plano. */
function dentroDoPlano(escolhidos: string[], plano: PlanoComprado | null): string[] {
  if (!plano?.paises.length) return escolhidos;
  const porChave = new Map(plano.paises.map((p) => [chaveTexto(p), p]));
  return [...new Set(escolhidos.map((p) => porChave.get(chaveTexto(p))).filter((p): p is string => !!p))];
}

const chaveDoChip = (c: { item_id: number | null; posicao: number }) => `${c.item_id ?? ''}:${c.posicao}`;

interface SituacaoChip {
  chip: ChipML;
  plano: PlanoComprado | null;
  cadastro: any;
}

/** Os chips do pedido, com o plano e o cadastro de cada um, separados em pendentes e travados. */
async function situacaoDoPedido(pedido: PedidoML) {
  const [planos, cadastros] = await Promise.all([planosDoPedido(pedido), cadastrosDoPedido(pedido)]);
  const todos: SituacaoChip[] = pedido.chips.map((chip) => ({
    chip,
    plano: planoDoChip(planos, pedido, chip),
    cadastro: cadastroDoChip(cadastros, pedido.id, chip),
  }));
  return {
    pendentes: todos.filter((s) => chipPendente(s.chip, s.cadastro)),
    travados: todos.filter((s) => estaBloqueado(s.cadastro)),
  };
}

/** Passo 2 da tela: os chips do pedido escolhido que faltam cadastrar, com o plano de cada um. */
export async function consultar(dados: ConsultaDados): Promise<Consulta> {
  const pedido = await pedidoDoCpf(dados.cpf, dados.pedido_id);
  if (!pedido) throw new PedidoIndisponivelError(MSG_NAO_ENCONTRADO);
  const { pendentes, travados } = await situacaoDoPedido(pedido);

  if (pendentes.length === 0) {
    if (travados.length === 0) throw new PedidoIndisponivelError(MSG_JA_ATIVADO);
    const { cadastro: c, plano } = travados[0];
    return {
      pedidoFinal: pedido.numero.slice(-4),
      chips: [],
      jaEnviados: travados.length,
      preenchimento: null,
      bloqueado: true,
      resumo: {
        plano: c.plan_title ?? plano?.titulo ?? null,
        destino: c.plan_destination ?? plano?.destino ?? null,
        dias: c.plan_days ?? plano?.dias ?? null,
        franquia: c.plan_data ?? plano?.franquia ?? null,
        paises: paisesDaLista(c.countries),
        ativacao: c.travel_start ?? null,
        fim: c.travel_end ?? fimDaVigencia(c.travel_start, c.plan_days ?? plano?.dias),
      },
    };
  }

  // Envio que parou no meio: devolve o que o próprio cliente digitou, para ele concluir.
  const doCliente = (cadastro: any) => (cadastro && cadastro.cpf === dados.cpf ? cadastro : null);
  const anterior = pendentes.map((s) => doCliente(s.cadastro)).find(Boolean);

  return {
    pedidoFinal: pedido.numero.slice(-4),
    chips: pendentes.map(({ chip, plano, cadastro }) => {
      const meu = doCliente(cadastro);
      const doPedido = dentroDoPlano(paisesDaLista(meu ? meu.countries : chip.destino), plano);
      return {
        item_id: chip.item_id,
        posicao: chip.posicao,
        tipo: chip.tipo,
        iccid: chip.tipo === 'fisico' ? chip.iccid : null,
        plano,
        travel_start: meu?.travel_start || '',
        countries: doPedido.length ? doPedido : plano?.paises.length === 1 ? plano.paises : [],
        jaCadastrado: !!cadastro,
      };
    }),
    jaEnviados: travados.length,
    preenchimento: anterior
      ? {
          full_name: anterior.full_name || '',
          email: anterior.email || '',
          phone: telefoneParaTela(anterior.phone),
          birth_date: anterior.birth_date || '',
        }
      : {
          full_name: pedido.customer_name || '',
          email: pedido.customer_email || '',
          phone: telefoneParaTela(pedido.customer_phone),
          birth_date: '',
        },
    bloqueado: false,
    resumo: null,
  };
}

export interface ResultadoCadastro {
  ids: string[];
  vinculadoAoPedido: boolean;
  /** Ativação e fim da vigência de cada chip cadastrado, na ordem do envio. */
  chips: { tipo: TipoChip; travel_start: string; vigenciaFim: string | null }[];
}

/**
 * Passo 3: grava o cadastro de todos os chips pendentes do pedido — uma linha por chip,
 * com o mesmo titular.
 *
 * Cadastro já enviado não é alterado (ver `estaBloqueado`); o reenvio só completa um
 * envio que parou antes de gravar a submissão da baixa.
 */
export async function registrarCadastro(
  dados: Cadastro,
  meta: { ip: string | null; userAgent: string | null },
): Promise<ResultadoCadastro> {
  const pedido = await pedidoDoCpf(dados.cpf, dados.pedido_id);
  if (!pedido) throw new PedidoIndisponivelError(MSG_NAO_ENCONTRADO);
  const { pendentes, travados } = await situacaoDoPedido(pedido);

  if (pendentes.length === 0) {
    if (travados.length) throw new CadastroBloqueadoError(MSG_BLOQUEADO);
    throw new PedidoIndisponivelError(MSG_JA_ATIVADO);
  }

  // O envio precisa trazer exatamente os chips que faltam, nem mais nem menos.
  const porChave = new Map(pendentes.map((s) => [chaveDoChip(s.chip), s]));
  const enviados = dados.chips.map((c) => ({ dados: c, situacao: porChave.get(chaveDoChip(c)) }));
  if (
    enviados.some((e) => !e.situacao) ||
    new Set(enviados.map((e) => chaveDoChip(e.dados))).size !== pendentes.length
  ) {
    throw new PedidoIndisponivelError(MSG_LISTA_MUDOU);
  }

  // Confere tudo antes de gravar o primeiro chip.
  const erros: Record<string, string> = {};
  const preparados = enviados.map(({ dados: c, situacao }, i) => {
    const { chip, plano, cadastro } = situacao!;
    // Chip físico: vale o ICCID lançado no pedido; sem ele, o que o cliente digitou.
    const iccidKey = chip.tipo === 'fisico' ? chip.iccid ?? (c.iccid ? chaveIccid(c.iccid) : null) : null;
    if (chip.tipo === 'fisico' && !iccidKey) erros[`chips.${i}.iccid`] = MSG_ICCID;
    // O navegador só oferece os países do plano, mas quem decide é o servidor.
    const paises = plano?.paises.length ? dentroDoPlano(c.countries, plano) : c.countries;
    if (paises.length !== c.countries.length) erros[`chips.${i}.countries`] = 'Selecione apenas países incluídos no plano';
    return { c, chip, plano, cadastro, iccidKey, paises };
  });

  const iccids = preparados.map((p) => p.iccidKey).filter((k): k is string => !!k);
  preparados.forEach((p, i) => {
    if (p.iccidKey && iccids.indexOf(p.iccidKey) !== iccids.lastIndexOf(p.iccidKey)) {
      erros[`chips.${i}.iccid`] = 'Este ICCID foi informado em mais de um chip';
    }
  });
  const proprios = new Set(preparados.map((p) => p.cadastro?.id).filter(Boolean));
  const ocupados = (await cadastrosDosIccids(iccids)).filter((c) => !proprios.has(c.id));
  preparados.forEach((p, i) => {
    if (p.iccidKey && ocupados.some((c) => c.iccid_key === p.iccidKey)) {
      erros[`chips.${i}.iccid`] = 'Este chip já foi cadastrado. Confira o número ou fale com o suporte.';
    }
  });
  if (Object.keys(erros).length) throw new CampoInvalidoError(erros);

  const agora = new Date().toISOString();
  const titular = {
    full_name: dados.full_name.replace(/\s+/g, ' '),
    cpf: dados.cpf,
    birth_date: dados.birth_date ?? null,
    email: dados.email,
    phone: dados.phone,
  };

  const ids: string[] = [];
  const resultado: ResultadoCadastro['chips'] = [];
  const historico: string[] = [];
  for (const { c, chip, plano, cadastro, iccidKey, paises } of preparados) {
    const vigenciaFim = fimDaVigencia(c.travel_start, plano?.dias);
    const linha = {
      updated_at: agora,
      iccid: iccidKey,
      iccid_key: iccidKey,
      chip_type: chip.tipo,
      order_id: pedido.id,
      order_number: pedido.numero,
      order_source: ORIGEM,
      item_id: chip.item_id,
      unit_index: chip.unit_index,
      unit_position: chip.posicao,
      order_number_informed: null,
      ...titular,
      travel_start: c.travel_start,
      travel_end: vigenciaFim,
      countries: paises.join(', '),
      plan_title: plano?.titulo ?? null,
      plan_destination: plano?.destino ?? null,
      plan_days: plano?.dias ?? null,
      plan_data: plano?.franquia ?? null,
      observation: dados.observation ?? null,
      lgpd_consent_at: agora,
      submitted_ip: meta.ip,
      user_agent: meta.userAgent?.slice(0, 300) ?? null,
    };

    let id: string;
    if (cadastro) {
      const { error } = await supabaseServer.from(TABELA).update(linha).eq('id', cadastro.id);
      if (error) {
        if ((error as any).code === '23505') throw new CadastroBloqueadoError(MSG_BLOQUEADO);
        throw new Error(`Falha ao atualizar cadastro: ${error.message}`);
      }
      id = cadastro.id;
    } else {
      const { data, error } = await supabaseServer.from(TABELA).insert(linha).select('id').single();
      if (error) {
        // 23505 = índice único: outro envio do mesmo chip chegou junto com este.
        if ((error as any).code === '23505') throw new CadastroBloqueadoError(MSG_BLOQUEADO);
        throw new Error(`Falha ao gravar cadastro: ${error.message}`);
      }
      id = data.id;
    }

    // A submissão é gravada por último e é ela que trava o cadastro do chip: se falhar
    // aqui, o cliente pode reenviar e concluir.
    const submissao = await gravarSubmissao(linha, pedido, plano, iccidKey);
    const { error: erroVinculo } = await supabaseServer.from(TABELA).update({ ml_submission_id: submissao }).eq('id', id);
    if (erroVinculo) console.error('[gochip] submissão não vinculada ao cadastro:', erroVinculo.message);

    const tipoTexto = chip.tipo === 'fisico' ? 'chip físico' : 'eSIM';
    historico.push(
      `${iccidKey ? `${tipoTexto} ICCID ${iccidKey}` : tipoTexto}: ativação ${linha.travel_start}${vigenciaFim ? ` até ${vigenciaFim}` : ''} — ${linha.countries}`,
    );

    await dispararGatilho({
      evento: 'cadastro_recebido',
      cadastro_id: id,
      iccid: iccidKey,
      tipo_chip: linha.chip_type,
      pedido: linha.order_number,
      origem: linha.order_source,
      chip: chip.posicao,
      nome: linha.full_name,
      email: linha.email,
      telefone: linha.phone,
      plano: linha.plan_title,
      destino: linha.plan_destination,
      dias: linha.plan_days,
      franquia: linha.plan_data,
      paises: linha.countries,
      inicio_uso: linha.travel_start,
      fim_uso: vigenciaFim,
    });

    ids.push(id);
    resultado.push({ tipo: chip.tipo, travel_start: c.travel_start, vigenciaFim });
  }

  await registrarNoCrm(pedido, [
    `[GoChip] Cadastro do titular recebido pelo cliente (${preparados.length} chip${preparados.length > 1 ? 's' : ''})`,
    `Titular: ${titular.full_name} (CPF ${mascararCpf(titular.cpf)})`,
    `Contato: ${titular.email} / +${titular.phone}`,
    ...historico,
  ].join(' — '));

  return { ids, vinculadoAoPedido: true, chips: resultado };
}

/**
 * A submissão que a baixa do pedido (/mercado-livre/baixa-pedido) consome — o mesmo
 * formato que o webhook do formulário do site gravava. Fica sem `linked_ml_order_id`: o
 * vínculo continua sendo confirmado pela equipe, que é quem leva os dados ao pedido e à
 * tabela mestre.
 */
async function gravarSubmissao(
  linha: Record<string, any>,
  pedido: PedidoML,
  plano: PlanoComprado | null,
  iccidKey: string | null,
): Promise<number> {
  const resumo = [
    '[GoChip]',
    plano ? `Plano: ${plano.titulo}` : 'Plano não identificado',
    plano?.dias ? `${plano.dias} dias` : null,
    plano?.franquia,
    pedido.chips.length > 1 ? `Chip ${linha.unit_position} de ${pedido.chips.length}` : null,
    iccidKey ? `ICCID ${iccidKey}` : null,
    `CPF do titular ${formatarCpf(linha.cpf)}`,
    linha.birth_date ? `Nascimento ${linha.birth_date}` : null,
  ].filter(Boolean).join(' — ');

  const row = {
    customer_order_number: pedido.numero,
    full_name: linha.full_name,
    email: linha.email,
    whatsapp: `+${linha.phone}`,
    type: linha.chip_type === 'virtual' ? 'eSIM' : 'Chip Físico',
    countries: linha.countries || null,
    travel_start_date: linha.travel_start,
    travel_end_date: linha.travel_end,
    observation: [resumo, linha.observation].filter(Boolean).join('\n'),
  };

  const { data, error } = await supabaseServer
    .from(SUBMISSOES)
    .insert({ ...row, submission_date: new Date().toISOString() })
    .select('id')
    .single();
  if (error) throw new Error(`Falha ao gravar a submissão: ${error.message}`);
  return (data as any).id;
}

/** Histórico do pedido. Falha aqui não derruba o cadastro (mesmo contrato do writeCRMLog). */
async function registrarNoCrm(pedido: PedidoML, conteudo: string) {
  const orderId = Number(pedido.id);
  if (!Number.isFinite(orderId)) return;
  try {
    await supabaseServer.from('order_crm_logs').insert({
      order_id: orderId,
      source: ORIGEM,
      date: new Date().toISOString(),
      method: 'GoChip',
      content: conteudo,
      type: 'system',
      created_by: 'GoChip',
      history: [],
    });
  } catch (e) {
    console.error('[gochip] CRM log não gravado:', (e as Error).message);
  }
}

/** Gatilho opcional para o Make.com. Sem URL ativa, não faz nada. */
async function dispararGatilho(payload: Record<string, unknown>) {
  try {
    const { data: config } = await supabaseServer
      .from('outgoing_webhook_configs')
      .select('url')
      .eq('trigger_name', GATILHO)
      .eq('is_active', true)
      .maybeSingle();
    if (!config?.url) return;

    const log: Record<string, unknown> = { trigger_name: GATILHO, payload };
    try {
      const res = await fetch(config.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(8000),
      });
      log.response_status = res.status;
      log.response_body = (await res.text().catch(() => '')).slice(0, 2000);
    } catch (e) {
      log.error = (e as Error).message;
    }
    await supabaseServer.from('outgoing_webhook_logs').insert(log);
  } catch (e) {
    console.error('[gochip] gatilho não disparado:', (e as Error).message);
  }
}
