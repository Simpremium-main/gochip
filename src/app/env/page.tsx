import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { supabaseServer } from '@/lib/supabase-server';

// Diagnóstico: tudo é lido a cada acesso, nunca do cache de build/rota.
export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const fetchCache = 'force-no-store';

export const metadata: Metadata = {
  title: 'GoChip — Variáveis de ambiente',
  robots: { index: false, follow: false },
};

type Variavel = {
  nome: string;
  secreta: boolean;
  padrao?: string;
  /** Valor como o código compilado enxerga (NEXT_PUBLIC_* é fixado no build). */
  noBuild?: string;
};

const VARIAVEIS: Variavel[] = [
  {
    nome: 'NEXT_PUBLIC_SUPABASE_URL',
    secreta: false,
    padrao: 'https://placeholder.supabase.co',
    noBuild: process.env.NEXT_PUBLIC_SUPABASE_URL,
  },
  { nome: 'SUPABASE_SERVICE_ROLE_KEY', secreta: true, padrao: 'placeholder' },
  { nome: 'ML_APP_ID', secreta: false },
  { nome: 'ML_CLIENT_SECRET', secreta: true },
  { nome: 'WHATSAPP_SUPORTE', secreta: false, padrao: '551149495008' },
  { nome: 'NODE_ENV', secreta: false },
  { nome: 'VERCEL_ENV', secreta: false },
  { nome: 'VERCEL_GIT_COMMIT_SHA', secreta: false },
];

// Gravado quando o módulo é avaliado: no build (se pré-renderizado) ou no 1º acesso do processo.
const CARREGADO_EM = new Date().toISOString();

function mascarar(valor: string): string {
  if (valor.length <= 10) return '•'.repeat(valor.length);
  return `${valor.slice(0, 4)}…${valor.slice(-4)} (${valor.length} caracteres)`;
}

function exibir(valor: string | undefined, secreta: boolean): string {
  if (valor === undefined) return '— não definida —';
  if (valor === '') return '— vazia —';
  return secreta ? mascarar(valor) : valor;
}

async function credenciaisMlNoBanco(): Promise<{ appId: boolean; secret: boolean; erro?: string }> {
  const { data, error } = await supabaseServer
    .from('system_settings')
    .select('value')
    .eq('id', 'mercado_livre_credenciais')
    .maybeSingle();
  if (error) return { appId: false, secret: false, erro: error.message };
  let salvo: any = (data as any)?.value;
  try {
    if (typeof salvo === 'string') salvo = JSON.parse(salvo);
  } catch {
    salvo = {};
  }
  return { appId: Boolean(salvo?.app_id), secret: Boolean(salvo?.client_secret) };
}

export default async function PaginaEnv({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  // Em produção só abre com ?token= igual a DIAGNOSTICO_TOKEN; sem o token configurado, 404.
  if (process.env.NODE_ENV === 'production') {
    const esperado = process.env['DIAGNOSTICO_TOKEN'];
    const { token } = await searchParams;
    if (!esperado || token !== esperado) notFound();
  }

  const ml = await credenciaisMlNoBanco().catch((e) => ({ appId: false, secret: false, erro: String(e) }));

  const linhas = VARIAVEIS.map((v) => {
    // Acesso por chave dinâmica: o Next não consegue substituir no build, então é o valor real do processo.
    const runtime = process.env[v.nome];
    const efetivo = runtime || v.padrao;
    const divergeDoBuild = 'noBuild' in v && v.noBuild !== runtime;
    return { ...v, runtime, efetivo, usandoPadrao: !runtime && v.padrao !== undefined, divergeDoBuild };
  });

  return (
    <div className="space-y-6 text-sm">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">Variáveis de ambiente</h1>
        <p className="mt-1 text-slate-500">
          Requisição: {new Date().toISOString()} · Módulo carregado: {CARREGADO_EM}
        </p>
      </div>

      <ul className="space-y-3">
        {linhas.map((l) => (
          <li key={l.nome} className="rounded-xl border border-slate-200 bg-white p-3">
            <div className="flex flex-wrap items-center gap-2">
              <code className="font-semibold">{l.nome}</code>
              {l.usandoPadrao && (
                <span className="rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-800">usando padrão do código</span>
              )}
              {l.divergeDoBuild && (
                <span className="rounded bg-red-100 px-1.5 py-0.5 text-xs text-red-800">diferente do build</span>
              )}
            </div>
            <dl className="mt-2 grid grid-cols-[auto,1fr] gap-x-3 gap-y-1 break-all">
              <dt className="text-slate-500">runtime</dt>
              <dd className="font-mono">{exibir(l.runtime, l.secreta)}</dd>
              {'noBuild' in l && (
                <>
                  <dt className="text-slate-500">no build</dt>
                  <dd className="font-mono">{exibir(l.noBuild, l.secreta)}</dd>
                </>
              )}
              {l.usandoPadrao && (
                <>
                  <dt className="text-slate-500">efetivo</dt>
                  <dd className="font-mono">{exibir(l.efetivo, l.secreta)}</dd>
                </>
              )}
            </dl>
          </li>
        ))}
      </ul>

      <div className="rounded-xl border border-slate-200 bg-white p-3">
        <p className="font-semibold">Mercado Livre — de onde vêm as credenciais</p>
        {ml.erro ? (
          <p className="mt-1 text-red-700">Erro ao ler system_settings: {ml.erro}</p>
        ) : (
          <ul className="mt-1 space-y-0.5">
            <li>App ID: {ml.appId ? 'system_settings (Pedido Central)' : 'ML_APP_ID (env)'}</li>
            <li>Client Secret: {ml.secret ? 'system_settings (Pedido Central)' : 'ML_CLIENT_SECRET (env)'}</li>
          </ul>
        )}
      </div>

      <p className="text-xs text-slate-400">
        NEXT_PUBLIC_* é fixado no código durante o build: se “runtime” e “no build” divergem, é preciso
        um novo build/deploy para a mudança valer.
      </p>
    </div>
  );
}
