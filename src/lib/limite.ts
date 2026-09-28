/**
 * Limite simples de requisições por IP, em memória.
 *
 * Numa hospedagem serverless cada instância tem a sua contagem, então isto freia
 * abuso casual (alguém varrendo ICCIDs), não um ataque distribuído.
 */
const janelas = new Map<string, { inicio: number; total: number }>();

export function dentroDoLimite(chave: string, maximo: number, janelaMs: number): boolean {
  const agora = Date.now();
  const atual = janelas.get(chave);
  if (!atual || agora - atual.inicio > janelaMs) {
    janelas.set(chave, { inicio: agora, total: 1 });
    if (janelas.size > 10_000) {
      for (const [k, v] of janelas) if (agora - v.inicio > janelaMs) janelas.delete(k);
    }
    return true;
  }
  atual.total += 1;
  return atual.total <= maximo;
}

export function ipDaRequisicao(request: Request): string | null {
  const fwd = request.headers.get('x-forwarded-for');
  return fwd?.split(',')[0]?.trim() || request.headers.get('x-real-ip') || null;
}
