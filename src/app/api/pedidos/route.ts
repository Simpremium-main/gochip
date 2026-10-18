import { NextResponse } from 'next/server';
import { pedidosSchema } from '@/lib/cadastro-schema';
import { pedidosPendentes } from '@/lib/pedido-central';
import { dentroDoLimite, ipDaRequisicao } from '@/lib/limite';

export const dynamic = 'force-dynamic';

// POST /api/pedidos — passo 1: os pedidos do Mercado Livre deste CPF ainda sem data de
// ativação. POST, e não GET, para o CPF não ir parar em URL e log.
export async function POST(request: Request) {
  const ip = ipDaRequisicao(request) ?? 'desconhecido';
  if (!dentroDoLimite(`pedidos:${ip}`, 20, 10 * 60_000)) {
    return NextResponse.json({ error: 'Muitas consultas. Aguarde alguns minutos.' }, { status: 429 });
  }

  let corpo: unknown;
  try {
    corpo = await request.json();
  } catch {
    return NextResponse.json({ error: 'Envio inválido.' }, { status: 400 });
  }

  const validado = pedidosSchema.safeParse(corpo);
  if (!validado.success) {
    const campos: Record<string, string> = {};
    for (const issue of validado.error.issues) campos[String(issue.path[0] ?? '_')] ??= issue.message;
    return NextResponse.json({ error: 'Confira os campos destacados.', campos }, { status: 422 });
  }

  try {
    return NextResponse.json(await pedidosPendentes(validado.data));
  } catch (e) {
    console.error('[api/pedidos]', (e as Error).message);
    return NextResponse.json({ error: 'Não foi possível consultar agora. Tente de novo.' }, { status: 502 });
  }
}
