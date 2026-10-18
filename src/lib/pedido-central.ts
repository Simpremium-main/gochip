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
  type Preenchimento, type TipoChip,
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

export interface PedidoML {
  /** PK interna de `mercado_livre_orders` — é o `order_id` da mestre e do CRM. */
  id: string;
  /** Número do pedido no Mercado Livre. */
  numero: string;
  titulo: string;
  tipo: TipoChip;
  item_id: number | null;
  unit_index: number | null;
  /** ICCID do chip físico lançado na mestre para este pedido; nulo se ainda não lançado. */
  iccid: string | null;
  customer_name: string | null;
  customer_cpf: string | null;
  customer_email: string | null;
  customer_phone: string | null;
  /** Dados da ativação já lançados no item (de um formulário anterior ou da equipe). */
  checkin: string | null;
  destino: string | null;
}

const COLUNAS_PEDIDO = 'id, order_id, plan_name, customer_name, customer_cpf, customer_email, customer_phone, confirmation_status, created_at';

/** O CPF pode estar gravado no pedido só com dígitos ou formatado. */
const grafiasCpf = (cpf: string) => [...new Set([cpf, formatarCpf(cpf)])];

/** Itens do pedido (um por anúncio vendido). */
async function itensDosPedidos(ids: string[]): Promise<any[]> {
  if (ids.length === 0) return [];
  const { data, error } = await supabaseServer
    .from('mercado_livre_order_items')
    .select('id, order_id, checkin, destino')
    .in('order_id', ids)
    .order('id');
  if (error) throw new Error(`Pedido Central indisponível: ${error.message}`);
  return (data || []) as any[];
}

/** Cadastros ativos do GoChip para estes pedidos. */
async function cadastrosDosPedidos(ids: string[]): Promise<any[]> {
  if (ids.length === 0) return [];
  const { data, error } = await supabaseServer
    .from(TABELA)
    .select('id, order_id, item_id, status, ml_submission_id, cpf, created_at')
    .in('order_id', ids)
    .neq('status', 'cancelado')
    .order('created_at', { ascending: false });
  if (error) throw new Error(`Falha ao consultar cadastros: ${error.message}`);
  return (data || []) as any[];
}

/** O cadastro de um item: o do próprio item, ou um do pedido gravado sem item. */
function cadastroDoItem(cadastros: any[], pedidoId: string, itemId: number | null) {
  return (
    cadastros.find((c) => String(c.order_id) === pedidoId && (itemId == null || c.item_id == null || Number(c.item_id) === itemId)) ??
    null
  );
}

/**
 * Passo 1: os pedidos do Mercado Livre deste CPF que ainda não têm data de ativação —
 * nem no item do pedido (`checkin`), nem num cadastro do GoChip já enviado.
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
  const [itens, cadastros] = await Promise.all([itensDosPedidos(ids), cadastrosDosPedidos(ids)]);

  const lista: PedidoPendente[] = [];
  for (const p of pedidos) {
    const id = String(p.id);
    const doPedido = itens.filter((i) => String(i.order_id) === id);
    // Pedido sem item lançado ainda conta como uma compra a ativar.
    const unidades = doPedido.length ? doPedido : [{ id: null, checkin: null }];
    for (const item of unidades) {
      if (item.checkin) continue;
      const itemId = item.id == null ? null : Number(item.id);
      const cadastro = cadastroDoItem(cadastros, id, itemId);
      if (estaBloqueado(cadastro)) continue;
      const lido = lerTitulo(String(p.plan_name || ''));
      lista.push({
        pedido_id: id,
        item_id: itemId,
        pedidoFinal: String(p.order_id).slice(-4),
        titulo: lido.titulo,
        tipo: tipoDoTitulo(lido.titulo),
        compradoEm: p.created_at ? String(p.created_at).slice(0, 10) : null,
        destino: lido.destino,
        dias: lido.dias,
        franquia: lido.franquia,
        envioIncompleto: !!cadastro,
      });
    }
  }
  return { pedidos: lista };
}

/**
 * O pedido escolhido na lista, conferindo de novo que ele é do CPF informado: o navegador
 * só manda a referência, e quem decide de quem é o pedido é o servidor.
 */
export async function pedidoDoCpf(cpf: string, pedidoId: string, itemId: number | null): Promise<PedidoML | null> {
  const { data, error } = await supabaseServer
    .from('mercado_livre_orders')
    .select(COLUNAS_PEDIDO)
    .eq('id', pedidoId)
    .neq('confirmation_status', 'rejected')
    .limit(1);
  if (error) throw new Error(`Pedido Central indisponível: ${error.message}`);
  const p = (data || [])[0] as any;
  if (!p || soDigitos(p.customer_cpf) !== cpf) return null;

  const itens = await itensDosPedidos([String(p.id)]);
  const item = itemId == null ? null : itens.find((i) => Number(i.id) === itemId);
  if (itemId != null && !item) return null;

  // ICCID do chip físico, se a equipe já lançou na mestre. O mesmo pedido pode ter mais de
  // uma linha; vale a do item escolhido e, entre elas, a mais recente.
  let mestre = supabaseServer
    .from('order_activations_master')
    .select('iccid, item_id, unit_index, date_created')
    .eq('source', ORIGEM)
    .eq('order_id', p.id);
  if (itemId != null) mestre = mestre.eq('item_id', itemId);
  const { data: linhas, error: erroMestre } = await mestre.order('date_created', { ascending: false }).limit(1);
  if (erroMestre) throw new Error(`Pedido Central indisponível: ${erroMestre.message}`);
  const ativacao = (linhas || [])[0] as any;

  const titulo = String(p.plan_name || '');
  return {
    id: String(p.id),
    numero: String(p.order_id),
    titulo,
    tipo: tipoDoTitulo(titulo),
    item_id: itemId,
    unit_index: ativacao?.unit_index ?? null,
    iccid: ativacao?.iccid && iccidValido(ativacao.iccid) ? chaveIccid(ativacao.iccid) : null,
    customer_name: p.customer_name ?? null,
    customer_cpf: p.customer_cpf ?? null,
    customer_email: p.customer_email ?? null,
    customer_phone: p.customer_phone ?? null,
    checkin: item?.checkin ? String(item.checkin).slice(0, 10) : null,
    destino: item?.destino ?? null,
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
 * O plano do pedido.
 *
 * 1. Pergunta ao Mercado Livre qual anúncio (MLB) foi vendido e procura o plano vinculado a
 *    ele na Tabela de Preço — é o caminho que não depende do título.
 * 2. Sem API ou sem vínculo pelo MLB, compara o título do pedido com o dos anúncios.
 * 3. Sem nenhum vínculo, lê o próprio título (destino, dias, franquia) e resolve os países
 *    pelo cadastro de países padronizados.
 */
export async function planoDoPedido(pedido: PedidoML): Promise<PlanoComprado | null> {
  const { anuncios, paises } = await catalogo();

  let itens: ItemVendido[] = [];
  try {
    itens = await itensDoPedidoML(pedido.numero);
  } catch (e) {
    console.error('[gochip] pedido não consultado no Mercado Livre:', (e as Error).message);
  }

  const tituloPedido = chaveTexto(pedido.titulo);
  const item = itens.find((i) => chaveTexto(i.titulo) === tituloPedido) || itens[0] || null;
  const titulo = pedido.titulo || item?.titulo || '';
  if (!titulo && !item) return null;

  const anuncio =
    (item && anuncios.find((a) => a.ml_item_id && String(a.ml_item_id) === item.itemId)) ||
    anuncios.find((a) => {
      const t = chaveTexto(a.titulo);
      return !!t && (t === tituloPedido || (!!item && t === chaveTexto(item.titulo)));
    }) ||
    null;

  const lido = lerTitulo(titulo);
  if (anuncio) {
    const cobertura = paisesDaLista(anuncio.countries);
    return {
      titulo: lido.titulo,
      destino: lido.destino || (cobertura.length === 1 ? cobertura[0] : null),
      dias: Number(anuncio.dias) || lido.dias,
      franquia: formatarFranquia(anuncio.franquia, !!anuncio.por_dia) || lido.franquia,
      paises: cobertura,
      origem: 'anuncio',
    };
  }
  return { ...lido, paises: paisesDoDestino(lido.destino, paises), origem: 'titulo' };
}

// ---------------------------------------------------------------------------------------
// Cadastro
// ---------------------------------------------------------------------------------------

/**
 * Cadastro ativo deste pedido (item) ou, no chip físico, deste ICCID — o ICCID é único
 * entre os cadastros ativos.
 */
async function cadastroAtivo(pedido: PedidoML, iccidKey: string | null) {
  const doPedido = cadastroDoItem(await cadastrosDosPedidos([pedido.id]), pedido.id, pedido.item_id);
  if (doPedido || !iccidKey) return doPedido ? await cadastroPorId(doPedido.id) : null;
  const { data, error } = await supabaseServer
    .from(TABELA)
    .select('*')
    .neq('status', 'cancelado')
    .eq('iccid_key', iccidKey)
    .order('created_at', { ascending: false })
    .limit(1);
  if (error) throw new Error(`Falha ao consultar cadastros: ${error.message}`);
  return ((data || [])[0] as any) ?? null;
}

async function cadastroPorId(id: string) {
  const { data, error } = await supabaseServer.from(TABELA).select('*').eq('id', id).maybeSingle();
  if (error) throw new Error(`Falha ao consultar cadastros: ${error.message}`);
  return data as any;
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
  'Este chip já foi cadastrado e os dados não podem mais ser alterados por aqui. Para corrigir algo, fale com o suporte.';

const MSG_NAO_ENCONTRADO = 'Não encontramos este pedido no seu CPF. Volte e escolha um pedido da lista.';
const MSG_JA_ATIVADO = 'Este pedido já tem data de ativação. Para alterar, fale com o suporte.';

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

function preenchimento(cpf: string, existente: any, pedido: PedidoML, plano: PlanoComprado | null): Preenchimento {
  // Envio que parou no meio: devolve o que o próprio cliente digitou, para ele concluir.
  if (existente && existente.cpf === cpf) {
    return {
      full_name: existente.full_name || '',
      email: existente.email || '',
      phone: telefoneParaTela(existente.phone),
      birth_date: existente.birth_date || '',
      travel_start: existente.travel_start || '',
      countries: dentroDoPlano(paisesDaLista(existente.countries), plano),
    };
  }
  const doPedido = dentroDoPlano(paisesDaLista(pedido.destino), plano);
  return {
    full_name: pedido.customer_name || '',
    email: pedido.customer_email || '',
    phone: telefoneParaTela(pedido.customer_phone),
    birth_date: '',
    travel_start: '',
    countries: doPedido.length ? doPedido : plano?.paises.length === 1 ? plano.paises : [],
  };
}

/** Passo 2 da tela: o pedido escolhido e o plano comprado. */
export async function consultar(dados: ConsultaDados): Promise<Consulta> {
  const pedido = await pedidoDoCpf(dados.cpf, dados.pedido_id, dados.item_id);
  if (!pedido) throw new PedidoIndisponivelError(MSG_NAO_ENCONTRADO);
  const [plano, existente] = await Promise.all([planoDoPedido(pedido), cadastroAtivo(pedido, pedido.iccid)]);
  const bloqueado = estaBloqueado(existente);
  if (!bloqueado && pedido.checkin) throw new PedidoIndisponivelError(MSG_JA_ATIVADO);

  return {
    tipo: pedido.tipo,
    iccid: pedido.tipo === 'fisico' ? pedido.iccid : null,
    pedidoFinal: pedido.numero.slice(-4),
    plano,
    preenchimento: bloqueado ? null : preenchimento(dados.cpf, existente, pedido, plano),
    jaCadastrado: !!existente,
    bloqueado,
    resumo: bloqueado
      ? {
          plano: existente.plan_title ?? plano?.titulo ?? null,
          destino: existente.plan_destination ?? plano?.destino ?? null,
          dias: existente.plan_days ?? plano?.dias ?? null,
          franquia: existente.plan_data ?? plano?.franquia ?? null,
          paises: paisesDaLista(existente.countries),
          ativacao: existente.travel_start ?? null,
          fim: existente.travel_end ?? fimDaVigencia(existente.travel_start, existente.plan_days ?? plano?.dias),
        }
      : null,
  };
}

export interface ResultadoCadastro {
  id: string;
  vinculadoAoPedido: boolean;
  vigenciaFim: string | null;
}

/**
 * Passo 3: grava o cadastro.
 *
 * Cadastro já enviado não é alterado (ver `estaBloqueado`); o reenvio só completa um
 * envio que parou antes de gravar a submissão da baixa.
 */
export async function registrarCadastro(
  dados: Cadastro,
  meta: { ip: string | null; userAgent: string | null },
): Promise<ResultadoCadastro> {
  const pedido = await pedidoDoCpf(dados.cpf, dados.pedido_id, dados.item_id);
  if (!pedido) throw new PedidoIndisponivelError(MSG_NAO_ENCONTRADO);
  const fisico = pedido.tipo === 'fisico';

  // Chip físico: vale o ICCID lançado no pedido; sem ele, o que o cliente digitou.
  const iccidKey = fisico ? pedido.iccid ?? (dados.iccid ? chaveIccid(dados.iccid) : null) : null;
  if (fisico && !iccidKey) throw new CampoInvalidoError({ iccid: MSG_ICCID });

  const [plano, existente] = await Promise.all([planoDoPedido(pedido), cadastroAtivo(pedido, iccidKey)]);

  if (estaBloqueado(existente)) throw new CadastroBloqueadoError(MSG_BLOQUEADO);
  if (pedido.checkin) throw new PedidoIndisponivelError(MSG_JA_ATIVADO);

  // O navegador só oferece os países do plano, mas quem decide é o servidor.
  const paises = plano?.paises.length ? dentroDoPlano(dados.countries, plano) : dados.countries;
  if (paises.length !== dados.countries.length) {
    throw new CampoInvalidoError({ countries: 'Selecione apenas países incluídos no seu plano' });
  }

  const vigenciaFim = fimDaVigencia(dados.travel_start, plano?.dias);
  const agora = new Date().toISOString();
  const linha = {
    updated_at: agora,
    iccid: iccidKey,
    iccid_key: iccidKey,
    chip_type: pedido.tipo,
    order_id: pedido.id,
    order_number: pedido.numero,
    order_source: ORIGEM,
    item_id: pedido.item_id,
    unit_index: pedido.unit_index,
    order_number_informed: null,
    full_name: dados.full_name.replace(/\s+/g, ' '),
    cpf: dados.cpf,
    birth_date: dados.birth_date ?? null,
    email: dados.email,
    phone: dados.phone,
    travel_start: dados.travel_start,
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
  if (existente) {
    const { error } = await supabaseServer.from(TABELA).update(linha).eq('id', existente.id);
    if (error) {
      // 23505: o ICCID digitado já está em outro cadastro ativo.
      if ((error as any).code === '23505') throw new CadastroBloqueadoError(MSG_BLOQUEADO);
      throw new Error(`Falha ao atualizar cadastro: ${error.message}`);
    }
    id = existente.id;
  } else {
    const { data, error } = await supabaseServer.from(TABELA).insert(linha).select('id').single();
    if (error) {
      // 23505 = índice único: outro envio do mesmo chip/pedido chegou junto com este, ou o
      // ICCID digitado já está cadastrado.
      if ((error as any).code === '23505') {
        throw new CadastroBloqueadoError(MSG_BLOQUEADO);
      }
      throw new Error(`Falha ao gravar cadastro: ${error.message}`);
    }
    id = data.id;
  }

  // A submissão é gravada por último e é ela que trava o cadastro: se falhar aqui, o
  // cliente pode reenviar e concluir.
  const submissao = await gravarSubmissao(linha, pedido, plano, iccidKey);
  const { error: erroVinculo } = await supabaseServer.from(TABELA).update({ ml_submission_id: submissao }).eq('id', id);
  if (erroVinculo) console.error('[gochip] submissão não vinculada ao cadastro:', erroVinculo.message);

  const tipoTexto = fisico ? 'chip físico' : 'eSIM';
  await registrarNoCrm(pedido, [
    '[GoChip] Cadastro do titular recebido pelo cliente',
    iccidKey ? `${tipoTexto} ICCID ${iccidKey}` : tipoTexto,
    `Titular: ${linha.full_name} (CPF ${mascararCpf(linha.cpf)})`,
    `Contato: ${linha.email} / +${linha.phone}`,
    `Ativação ${linha.travel_start}${vigenciaFim ? ` até ${vigenciaFim}` : ''} — ${linha.countries}`,
  ].join(' — '));

  await dispararGatilho({
    evento: 'cadastro_recebido',
    cadastro_id: id,
    iccid: iccidKey,
    tipo_chip: linha.chip_type,
    pedido: linha.order_number,
    origem: linha.order_source,
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

  return { id, vinculadoAoPedido: true, vigenciaFim };
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
