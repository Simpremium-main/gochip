/**
 * O plano que o cliente comprou no Mercado Livre: destino, período, franquia e países.
 * Tudo aqui é puro (sem rede): roda igual no navegador e no servidor, e é testável.
 */

export interface PlanoComprado {
  /** Título do produto como veio no pedido do Mercado Livre. */
  titulo: string;
  /** Destino para mostrar ao cliente: "Estados Unidos", "Europa + Turquia". */
  destino: string | null;
  dias: number | null;
  /** "3GB", "1GB/dia", "Ilimitado", "Pacote diário" — já pronta para exibir. */
  franquia: string | null;
  /** Países que o plano cobre, nomes padronizados. Vazio = cobertura desconhecida. */
  paises: string[];
  /** De onde vieram os dados: do anúncio vinculado ao plano ou só da leitura do título. */
  origem: 'anuncio' | 'titulo';
}

export const semAcento = (v: unknown): string =>
  String(v ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '');

/** Chave de comparação: sem acento, sem caixa e sem espaço dobrado. */
export const chaveTexto = (v: unknown): string =>
  semAcento(v).toLowerCase().replace(/\s+/g, ' ').trim();

export function paisesDaLista(lista: string | null | undefined): string[] {
  return [...new Set(String(lista ?? '').split(',').map((p) => p.trim()).filter(Boolean))];
}

/** Franquia para exibir, a partir do texto da tabela e se o plano é diário. */
export function formatarFranquia(franquia: string | null | undefined, porDia = false): string | null {
  const f = String(franquia ?? '').trim().replace(/\s+(GB|MB|TB)\b/i, '$1');
  if (!f) return porDia ? 'Pacote diário' : null;
  if (/ilimitad|unlimited/i.test(f)) return 'Ilimitado';
  if (!porDia || /\/\s*dia|por\s*dia|per\s*day/i.test(f)) return f;
  return `${f}/dia`;
}

/** Palavras do título que não fazem parte do destino. */
const RUIDO = [
  /\bchips?\b/g,
  /\bvirtua(?:l|is)\b/g,
  /\be-?sims?\b/g,
  /\bfisicos?\b/g,
  /\binternet\b/g,
  /\bpre-?pagos?\b/g,
  /\b\d+\s*dias?\b/g,
  /\b\d+\s*paises\b/g,
  /[\d.,]+\s*(?:gb|mb|tb)\b(?:\s*\/\s*dia)?/g,
  /\bilimitad[oa]s?\b/g,
];

/**
 * O que o título do anúncio diz, para quando o anúncio não está vinculado a um plano.
 *
 *   "Chip Virtual Esim Estados Unidos 30 Dias 3gb - Internet Esim"
 *     → destino "Estados Unidos", 30 dias, 3GB
 *   "Chip Esim Europa 33 Países - 5GB - 15 dias"
 *     → destino "Europa", 15 dias, 5GB
 *
 * O destino sai do primeiro trecho do título (antes do primeiro " - "), sem as palavras
 * de produto, dias e franquia. Mantém a grafia original, só tira o que sobrou em volta.
 */
export function lerTitulo(titulo: string): Omit<PlanoComprado, 'paises' | 'origem'> {
  const t = String(titulo ?? '').trim();
  const simples = semAcento(t).toLowerCase();

  const mDias = simples.match(/\b(\d+)\s*dias?\b/);
  const dias = mDias ? Number(mDias[1]) : null;

  const porDia = /\/\s*dia\b|por\s+dia\b|\bdiari[oa]\b/.test(simples);
  const ilimitado = /\bilimitad|unlimited/.test(simples);
  const mFranquia = simples.match(/([\d]+(?:[.,]\d+)?)\s*(gb|mb|tb)\b/);
  const franquia = ilimitado
    ? 'Ilimitado'
    : formatarFranquia(mFranquia ? `${mFranquia[1].replace('.', ',')}${mFranquia[2].toUpperCase()}` : null, porDia);

  // O destino é cortado da versão sem acento e devolvido com a grafia original, que tem
  // o mesmo comprimento: a normalização só remove as marcas de acento.
  const trecho = t.split(/\s+-\s+/)[0];
  const original = trecho.normalize('NFC');
  const base = semAcento(original);
  let mascara = base.toLowerCase();
  for (const r of RUIDO) mascara = mascara.replace(r, (m) => ' '.repeat(m.length));
  let destino = '';
  if (base.length === original.length) {
    destino = [...mascara].map((c, i) => (c === ' ' ? ' ' : original[i])).join('');
  } else {
    destino = mascara;
  }
  destino = destino.replace(/\s+/g, ' ').replace(/^[\s\-–,+/]+|[\s\-–,+/]+$/g, '').trim();

  return { titulo: t, destino: destino || null, dias, franquia };
}

/** Data ISO (aaaa-mm-dd) somada de `n` dias, sem fuso horário no meio. */
export function somarDias(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * Último dia de uso: o dia da ativação conta como o 1º. 30 dias a partir de 10/10 vão
 * até 08/11 — a mesma regra da baixa do pedido no Pedido Central (ativação + período − 1).
 */
export function fimDaVigencia(inicio: string | null | undefined, dias: number | null | undefined): string | null {
  if (!inicio || !/^\d{4}-\d{2}-\d{2}$/.test(inicio) || !dias || dias < 1) return null;
  return somarDias(inicio, dias - 1);
}

export function formatarDataBR(iso: string | null | undefined): string {
  if (!iso) return '';
  const [a, m, d] = iso.slice(0, 10).split('-');
  return `${d}/${m}/${a}`;
}
