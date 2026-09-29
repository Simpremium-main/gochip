import 'server-only';
import { supabaseServer } from '@/lib/supabase-server';

/**
 * Leitura de pedidos na API do Mercado Livre, com a conta que o Pedido Central conectou.
 *
 * As credenciais moram em `system_settings` (`mercado_livre_credenciais`), gravadas pelo
 * Pedido Central — o GoChip não tem tela de conexão, só usa a mesma conta.
 *
 * O refresh token do ML é de USO ÚNICO: cada renovação invalida o anterior. Por isso a
 * renovação aqui segue o mesmo contrato do Pedido Central — relê o banco antes, grava o
 * par novo antes de usar e mescla com o que já estava salvo. Se as duas aplicações
 * renovarem ao mesmo tempo, a que perder recebe `invalid_grant`; aqui isso é tratado
 * relendo o banco, onde já está o token que a outra acabou de gravar.
 */

const API_BASE = 'https://api.mercadolibre.com';
const TIMEOUT_MS = 15000;
const SETTING_ML = 'mercado_livre_credenciais';

async function lerSalvo(): Promise<Record<string, any>> {
  const { data } = await supabaseServer.from('system_settings').select('value').eq('id', SETTING_ML).maybeSingle();
  const bruto: any = (data as any)?.value;
  try {
    return (typeof bruto === 'string' ? JSON.parse(bruto) : bruto) || {};
  } catch {
    return {};
  }
}

let renovando: Promise<string> | null = null;

async function renovar(): Promise<string> {
  const salvo = await lerSalvo();
  const refresh = String(salvo.refresh_token || '').trim();
  const appId = String(salvo.app_id || process.env.ML_APP_ID || '').trim();
  const secret = String(salvo.client_secret || process.env.ML_CLIENT_SECRET || '').trim();
  if (!refresh || !appId || !secret) throw new Error('conta do Mercado Livre não conectada');

  const res = await fetch(`${API_BASE}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: appId,
      client_secret: secret,
      refresh_token: refresh,
    }).toString(),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const dados = await res.json().catch(() => ({}));
  if (!res.ok) {
    // Outra aplicação pode ter renovado com este mesmo refresh token segundos antes.
    const atual = await lerSalvo();
    if (atual.refresh_token && atual.refresh_token !== refresh && Number(atual.expira_em || 0) > Date.now()) {
      return String(atual.access_token);
    }
    throw new Error(dados?.message || dados?.error || `HTTP ${res.status}`);
  }

  // Grava ANTES de devolver: o refresh token velho já morreu nesta chamada. Relê para
  // mesclar com o que estiver salvo agora, sem apagar campos do Pedido Central.
  const atual = await lerSalvo();
  const { error } = await supabaseServer.from('system_settings').upsert(
    {
      id: SETTING_ML,
      value: {
        ...atual,
        access_token: dados.access_token,
        refresh_token: dados.refresh_token,
        expira_em: Date.now() + (Number(dados.expires_in || 21600) - 60) * 1000,
      },
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'id' },
  );
  if (error) throw new Error(`não foi possível gravar o token do Mercado Livre: ${error.message}`);
  return String(dados.access_token);
}

async function tokenValido(): Promise<string> {
  const salvo = await lerSalvo();
  const token = String(salvo.access_token || '').trim();
  if (!token) throw new Error('conta do Mercado Livre não conectada');
  if (Number(salvo.expira_em || 0) > Date.now()) return token;
  renovando ??= renovar().finally(() => { renovando = null; });
  return renovando;
}

/** GET autenticado. Devolve `null` em 404 (pedido/pack inexistente para esta conta). */
async function mlGet<T = any>(caminho: string): Promise<T | null> {
  const chamar = (token: string) =>
    fetch(`${API_BASE}${caminho}`, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

  let res = await chamar(await tokenValido());
  if (res.status === 401) {
    renovando ??= renovar().finally(() => { renovando = null; });
    res = await chamar(await renovando);
  }
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Mercado Livre respondeu HTTP ${res.status} em ${caminho}`);
  return (await res.json()) as T;
}

export interface ItemVendido {
  /** Código do anúncio (MLB…). */
  itemId: string;
  titulo: string;
}

/**
 * Os anúncios vendidos num pedido.
 *
 * O número que o cliente vê no Mercado Livre é o do pedido ou, numa compra de carrinho,
 * o do pacote (pack). Tenta como pedido e, se não existir, como pacote.
 */
export async function itensDoPedidoML(numero: string): Promise<ItemVendido[]> {
  const id = String(numero || '').replace(/\D/g, '');
  if (!id) return [];

  const itensDe = (pedido: any): ItemVendido[] =>
    (Array.isArray(pedido?.order_items) ? pedido.order_items : [])
      .map((oi: any) => ({ itemId: String(oi?.item?.id || ''), titulo: String(oi?.item?.title || '') }))
      .filter((i: ItemVendido) => i.itemId);

  const pedido = await mlGet<any>(`/orders/${id}`);
  if (pedido) return itensDe(pedido);

  const pack = await mlGet<any>(`/packs/${id}`);
  const pedidos: any[] = Array.isArray(pack?.orders) ? pack.orders : [];
  const itens: ItemVendido[] = [];
  for (const p of pedidos.slice(0, 10)) {
    const completo = await mlGet<any>(`/orders/${p.id}`);
    itens.push(...itensDe(completo));
  }
  return itens;
}
