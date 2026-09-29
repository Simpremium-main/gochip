import 'server-only';
import { supabaseServer } from '@/lib/supabase-server';
import { chaveIccid, formatarCpf, mascararCpf, soDigitos } from '@/lib/documentos';
import { itensDoPedidoML, type ItemVendido } from '@/lib/mercado-livre';
import {
  chaveTexto, fimDaVigencia, formatarFranquia, lerTitulo, paisesDaLista, type PlanoComprado,
} from '@/lib/plano';
import type { Cadastro, Consulta, ConsultaDados, Preenchimento } from '@/lib/cadastro-schema';

/**
 * Integração com o banco do Pedido Central — só pedidos do MERCADO LIVRE.
 *
 * Lê:
 *   - `order_activations_master` (source = 'mercado-livre'): o ICCID do chip físico → pedido;
 *   - `mercado_livre_orders` / `mercado_livre_order_items`: o pedido, o comprador e o título;
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
  item_id: number | null;
  unit_index: number | null;
  customer_name: string | null;
  customer_cpf: string | null;
  customer_email: string | null;
  customer_phone: string | null;
  /** Dados da ativação já lançados no item (de um formulário anterior ou da equipe). */
  checkin: string | null;
  destino: string | null;
}

async function carregarPedido(filtro: { id?: string; numero?: string }, unidade?: { item_id: number | null; unit_index: number | null }): Promise<PedidoML | null> {
  let q = supabaseServer
    .from('mercado_livre_orders')
    .select('id, order_id, plan_name, customer_name, customer_cpf, customer_email, customer_phone, confirmation_status, created_at')
    .neq('confirmation_status', 'rejected');
  q = filtro.id ? q.eq('id', filtro.id) : q.eq('order_id', filtro.numero!);
  const { data, error } = await q.order('created_at', { ascending: false }).limit(1);
  if (error) throw new Error(`Pedido Central indisponível: ${error.message}`);
  const p = (data || [])[0] as any;
  if (!p) return null;

  let itemQ = supabaseServer.from('mercado_livre_order_items').select('id, checkin, destino').eq('order_id', p.id);
  if (unidade?.item_id != null) itemQ = itemQ.eq('id', unidade.item_id);
  const { data: itens } = await itemQ.order('id').limit(1);
  const item = (itens || [])[0] as any;

  return {
    id: String(p.id),
    numero: String(p.order_id),
    titulo: String(p.plan_name || ''),
    item_id: unidade?.item_id ?? item?.id ?? null,
    unit_index: unidade?.unit_index ?? null,
    customer_name: p.customer_name ?? null,
    customer_cpf: p.customer_cpf ?? null,
    customer_email: p.customer_email ?? null,
    customer_phone: p.customer_phone ?? null,
    checkin: item?.checkin ? String(item.checkin).slice(0, 10) : null,
    destino: item?.destino ?? null,
  };
}

/**
 * Chip físico: o ICCID na tabela mestre, só entre pedidos do Mercado Livre. O mesmo ICCID
 * pode ter sido vendido mais de uma vez; vale o registro mais recente.
 */
export async function buscarPorIccid(iccid: string): Promise<PedidoML | null> {
  const chave = chaveIccid(iccid);
  if (!chave) return null;
  const variantes = [...new Set([iccid.trim(), chave, chave.toLowerCase()])];
  const { data, error } = await supabaseServer
    .from('order_activations_master')
    .select('order_id, item_id, unit_index, date_created')
    .eq('source', ORIGEM)
    .in('iccid', variantes);
  if (error) throw new Error(`Pedido Central indisponível: ${error.message}`);
  const linhas = (data || []) as any[];
  if (linhas.length === 0) return null;
  const u = linhas.reduce((a, b) => (String(b.date_created || '') > String(a.date_created || '') ? b : a));
  if (u.order_id == null) return null;
  return carregarPedido({ id: String(u.order_id) }, { item_id: u.item_id ?? null, unit_index: u.unit_index ?? null });
}

/** eSIM: o número do pedido que o cliente vê no Mercado Livre. */
export async function buscarPorNumero(numero: string): Promise<PedidoML | null> {
  const n = soDigitos(numero);
  return n ? carregarPedido({ numero: n }) : null;
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

/** Cadastro ativo deste chip (físico, pelo ICCID) ou deste pedido (eSIM, pelo número). */
async function cadastroAtivo(dados: { chip_type: 'fisico' | 'virtual'; iccid?: string; order_number?: string }, pedido: PedidoML | null) {
  let q = supabaseServer.from(TABELA).select('*').neq('status', 'cancelado');
  if (dados.chip_type === 'fisico') {
    q = q.eq('iccid_key', chaveIccid(dados.iccid));
  } else {
    const numero = soDigitos(pedido?.numero ?? dados.order_number);
    if (!numero) return null;
    q = q.eq('chip_type', 'virtual').is('iccid_key', null)
      .or(`order_number.eq.${numero},order_number_informed.eq.${numero}`);
  }
  const { data, error } = await q.order('created_at', { ascending: false }).limit(1);
  if (error) throw new Error(`Falha ao consultar cadastros: ${error.message}`);
  return ((data || [])[0] as any) ?? null;
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

function preenchimento(cpf: string, existente: any, pedido: PedidoML | null, plano: PlanoComprado | null): Preenchimento | null {
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
  if (pedido && soDigitos(pedido.customer_cpf) === cpf) {
    const doPedido = dentroDoPlano(paisesDaLista(pedido.destino), plano);
    return {
      full_name: pedido.customer_name || '',
      email: pedido.customer_email || '',
      phone: telefoneParaTela(pedido.customer_phone),
      birth_date: '',
      travel_start: pedido.checkin || '',
      countries: doPedido.length ? doPedido : plano?.paises.length === 1 ? plano.paises : [],
    };
  }
  return null;
}

/** Passo 1 da tela: localizar a compra e o plano. */
export async function consultar(dados: ConsultaDados): Promise<Consulta> {
  const pedido = dados.chip_type === 'fisico' ? await buscarPorIccid(dados.iccid!) : await buscarPorNumero(dados.order_number!);
  const [plano, existente] = await Promise.all([pedido ? planoDoPedido(pedido) : null, cadastroAtivo(dados, pedido)]);
  const bloqueado = estaBloqueado(existente);
  const donoDoCadastro =
    !!existente && (existente.cpf === dados.cpf || (!!pedido && soDigitos(pedido.customer_cpf) === dados.cpf));

  return {
    tipo: dados.chip_type,
    iccid: dados.chip_type === 'fisico' ? chaveIccid(dados.iccid) : null,
    encontrado: !!pedido,
    pedidoFinal: pedido ? pedido.numero.slice(-4) : null,
    plano,
    preenchimento: bloqueado ? null : preenchimento(dados.cpf, existente, pedido, plano),
    jaCadastrado: !!existente,
    bloqueado,
    resumo:
      bloqueado && donoDoCadastro
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
 * Passo 2: grava o cadastro.
 *
 * Cadastro já enviado não é alterado (ver `estaBloqueado`); o reenvio só completa um
 * envio que parou antes de gravar a submissão da baixa.
 */
export async function registrarCadastro(
  dados: Cadastro,
  meta: { ip: string | null; userAgent: string | null },
): Promise<ResultadoCadastro> {
  const fisico = dados.chip_type === 'fisico';
  const pedido = fisico ? await buscarPorIccid(dados.iccid!) : await buscarPorNumero(dados.order_number!);
  const [plano, existente] = await Promise.all([pedido ? planoDoPedido(pedido) : null, cadastroAtivo(dados, pedido)]);

  if (estaBloqueado(existente)) throw new CadastroBloqueadoError(MSG_BLOQUEADO);

  // O navegador só oferece os países do plano, mas quem decide é o servidor.
  const paises = plano?.paises.length ? dentroDoPlano(dados.countries, plano) : dados.countries;
  if (paises.length !== dados.countries.length) {
    throw new CampoInvalidoError({ countries: 'Selecione apenas países incluídos no seu plano' });
  }

  const iccidKey = fisico ? chaveIccid(dados.iccid) : null;
  const vigenciaFim = fimDaVigencia(dados.travel_start, plano?.dias);
  const agora = new Date().toISOString();
  const linha = {
    updated_at: agora,
    iccid: fisico ? dados.iccid!.trim() : null,
    iccid_key: iccidKey,
    chip_type: dados.chip_type,
    order_id: pedido?.id ?? null,
    order_number: pedido?.numero ?? null,
    order_source: pedido ? ORIGEM : null,
    item_id: pedido?.item_id ?? null,
    unit_index: pedido?.unit_index ?? null,
    order_number_informed: dados.order_number ?? null,
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
    if (error) throw new Error(`Falha ao atualizar cadastro: ${error.message}`);
    id = existente.id;
  } else {
    const { data, error } = await supabaseServer.from(TABELA).insert(linha).select('id').single();
    if (error) {
      // 23505 = índice único: outro envio do mesmo chip/pedido chegou junto com este.
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
  if (pedido) {
    await registrarNoCrm(pedido, [
      '[GoChip] Cadastro do titular recebido pelo cliente',
      iccidKey ? `${tipoTexto} ICCID ${iccidKey}` : tipoTexto,
      `Titular: ${linha.full_name} (CPF ${mascararCpf(linha.cpf)})`,
      `Contato: ${linha.email} / +${linha.phone}`,
      `Ativação ${linha.travel_start}${vigenciaFim ? ` até ${vigenciaFim}` : ''} — ${linha.countries}`,
    ].join(' — '));
  }

  await dispararGatilho({
    evento: 'cadastro_recebido',
    cadastro_id: id,
    iccid: iccidKey,
    tipo_chip: linha.chip_type,
    pedido: linha.order_number ?? linha.order_number_informed,
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

  return { id, vinculadoAoPedido: !!pedido, vigenciaFim };
}

/**
 * A submissão que a baixa do pedido (/mercado-livre/baixa-pedido) consome — o mesmo
 * formato que o webhook do formulário do site gravava. Fica sem `linked_ml_order_id`: o
 * vínculo continua sendo confirmado pela equipe, que é quem leva os dados ao pedido e à
 * tabela mestre.
 */
async function gravarSubmissao(
  linha: Record<string, any>,
  pedido: PedidoML | null,
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
    customer_order_number: pedido?.numero ?? linha.order_number_informed ?? (iccidKey ? `ICCID ${iccidKey}` : ''),
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
