import 'server-only';
import { supabaseServer } from '@/lib/supabase-server';
import { chaveIccid, mascararCpf } from '@/lib/documentos';
import type { Cadastro, ConsultaChip, TipoChip } from '@/lib/cadastro-schema';

/**
 * Integração com o banco do Pedido Central.
 *
 * Lê: `order_activations_master` (um registro por unidade de chip vendida, com o pedido).
 * Grava: `chip_registrations` (o cadastro do titular), `order_crm_logs` (histórico do
 * pedido) e, se configurado, dispara o gatilho `gochip_cadastro` de
 * `outgoing_webhook_configs`, registrando em `outgoing_webhook_logs` — o mesmo caminho
 * que o `dispatchOutgoingWebhook()` do Pedido Central usa.
 */

const TABELA = 'chip_registrations';
const GATILHO = 'gochip_cadastro';

export interface UnidadeDoPedido {
  order_id: string | null;
  order_number: string | null;
  source: string | null;
  item_id: number | null;
  unit_index: number | null;
  tipo: TipoChip;
}

/** Mesma lista de palavras de `textoDeChipVirtual` no Pedido Central. */
const textoVirtual = (t: unknown) => /esim|e-sim|virtual/i.test(String(t ?? ''));

/**
 * `is_virtual_chip` é o marcador explícito e manda. Linhas antigas, de antes da coluna,
 * caem para o texto de `operator_detected` (mesma regra de `ehChipVirtual`).
 */
function tipoDaUnidade(row: any): TipoChip {
  if (typeof row.is_virtual_chip === 'boolean') return row.is_virtual_chip ? 'virtual' : 'fisico';
  return textoVirtual(row.operator_detected) || textoVirtual(row.plan_name) ? 'virtual' : 'fisico';
}

const CAMPOS = 'order_id, order_number, source, item_id, unit_index, iccid, operator_detected, plan_name, date_created';

/**
 * A unidade de pedido de um ICCID, pela tabela mestre.
 *
 * Busca por igualdade com as variações de caixa (usa índice). O mesmo ICCID pode ter sido
 * vendido mais de uma vez; vale o registro mais recente, como em `vigenciaPorIccid`.
 */
export async function buscarUnidadePorIccid(iccid: string): Promise<UnidadeDoPedido | null> {
  const chave = chaveIccid(iccid);
  if (!chave) return null;
  const variantes = [...new Set([iccid.trim(), chave, chave.toLowerCase()])];

  // `is_virtual_chip` pode não existir em bancos mais antigos: tenta com ela e, se a
  // coluna faltar, repete sem.
  const consultar = (campos: string) =>
    supabaseServer.from('order_activations_master').select(campos).in('iccid', variantes);
  let { data, error } = await consultar(`${CAMPOS}, is_virtual_chip`);
  if (error) ({ data, error } = await consultar(CAMPOS));
  if (error) throw new Error(`Pedido Central indisponível: ${error.message}`);

  const linhas = (data || []) as any[];
  if (linhas.length === 0) return null;
  const maisRecente = linhas.reduce((a, b) =>
    String(b.date_created || '') > String(a.date_created || '') ? b : a,
  );
  return {
    order_id: maisRecente.order_id != null ? String(maisRecente.order_id) : null,
    order_number: maisRecente.order_number != null
      ? String(maisRecente.order_number)
      : maisRecente.order_id != null ? String(maisRecente.order_id) : null,
    source: maisRecente.source ?? null,
    item_id: maisRecente.item_id ?? null,
    unit_index: maisRecente.unit_index ?? null,
    tipo: tipoDaUnidade(maisRecente),
  };
}

async function cadastroAtivo(iccidKey: string) {
  const { data, error } = await supabaseServer
    .from(TABELA)
    .select('id, status')
    .eq('iccid_key', iccidKey)
    .neq('status', 'cancelado')
    .maybeSingle();
  if (error) throw new Error(`Falha ao consultar cadastros: ${error.message}`);
  return data as { id: string; status: string } | null;
}

/** Passo 1 da tela: o cliente digitou o número do chip. */
export async function consultarChip(iccid: string): Promise<ConsultaChip> {
  const chave = chaveIccid(iccid);
  const [unidade, existente] = await Promise.all([buscarUnidadePorIccid(iccid), cadastroAtivo(chave)]);
  const numero = unidade?.order_number ?? null;
  return {
    iccid: chave,
    encontrado: !!unidade,
    tipo: unidade?.tipo ?? null,
    pedidoFinal: numero ? numero.slice(-4) : null,
    jaCadastrado: !!existente,
    bloqueado: existente?.status === 'conferido',
  };
}

export class CadastroBloqueadoError extends Error {}

export interface ResultadoCadastro {
  id: string;
  atualizado: boolean;
  vinculadoAoPedido: boolean;
}

/**
 * Passo 2: grava o cadastro no Pedido Central.
 *
 * Reenvio do mesmo chip enquanto a equipe não conferiu atualiza a linha (o cliente
 * corrigindo um dado); depois de conferido, o cadastro fica travado.
 */
export async function registrarCadastro(
  dados: Cadastro,
  meta: { ip: string | null; userAgent: string | null },
): Promise<ResultadoCadastro> {
  const iccidKey = chaveIccid(dados.iccid);
  const [unidade, existente] = await Promise.all([buscarUnidadePorIccid(dados.iccid), cadastroAtivo(iccidKey)]);

  if (existente?.status === 'conferido') {
    throw new CadastroBloqueadoError(
      'Este chip já foi cadastrado e conferido pela nossa equipe. Para alterar algum dado, fale com o suporte.',
    );
  }

  const agora = new Date().toISOString();
  const linha = {
    updated_at: agora,
    iccid: dados.iccid.trim(),
    iccid_key: iccidKey,
    // O tipo registrado no pedido prevalece sobre o que o cliente escolheu.
    chip_type: unidade?.tipo ?? dados.chip_type,
    order_id: unidade?.order_id ?? null,
    order_number: unidade?.order_number ?? null,
    order_source: unidade?.source ?? null,
    item_id: unidade?.item_id ?? null,
    unit_index: unidade?.unit_index ?? null,
    order_number_informed: dados.order_number_informed ?? null,
    full_name: dados.full_name.replace(/\s+/g, ' '),
    cpf: dados.cpf,
    birth_date: dados.birth_date ?? null,
    email: dados.email,
    phone: dados.phone,
    travel_start: dados.travel_start ?? null,
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
      // 23505 = índice único: outro envio do mesmo chip chegou junto com este.
      if ((error as any).code === '23505') {
        throw new CadastroBloqueadoError('Este chip acabou de ser cadastrado. Atualize a página e tente novamente.');
      }
      throw new Error(`Falha ao gravar cadastro: ${error.message}`);
    }
    id = data.id;
  }

  const tipoTexto = linha.chip_type === 'virtual' ? 'eSIM' : 'chip físico';
  if (unidade?.order_id) {
    await registrarNoCrm(unidade, [
      `[GoChip] ${existente ? 'Cadastro do titular atualizado' : 'Cadastro do titular recebido'} pelo cliente`,
      `${tipoTexto} ICCID ${iccidKey}`,
      `Titular: ${linha.full_name} (CPF ${mascararCpf(linha.cpf)})`,
      `Contato: ${linha.email} / +${linha.phone}`,
      `Item ${unidade.item_id ?? '-'}-${unidade.unit_index ?? 0}`,
    ].join(' — '));
  }

  await dispararGatilho({
    evento: existente ? 'cadastro_atualizado' : 'cadastro_recebido',
    cadastro_id: id,
    iccid: iccidKey,
    tipo_chip: linha.chip_type,
    pedido: linha.order_number,
    origem: linha.order_source,
    nome: linha.full_name,
    email: linha.email,
    telefone: linha.phone,
    inicio_uso: linha.travel_start,
  });

  return { id, atualizado: !!existente, vinculadoAoPedido: !!unidade?.order_id };
}

/** Histórico do pedido. Falha aqui não derruba o cadastro (mesmo contrato do writeCRMLog). */
async function registrarNoCrm(unidade: UnidadeDoPedido, conteudo: string) {
  const orderId = Number(unidade.order_id);
  if (!Number.isFinite(orderId)) return;
  try {
    await supabaseServer.from('order_crm_logs').insert({
      order_id: orderId,
      source: unidade.source || 'main',
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
