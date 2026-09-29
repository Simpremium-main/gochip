import { NextResponse } from 'next/server';
import { consultaSchema } from '@/lib/cadastro-schema';
import { consultar } from '@/lib/pedido-central';
import { dentroDoLimite, ipDaRequisicao } from '@/lib/limite';

export const dynamic = 'force-dynamic';

// POST /api/consulta — passo 1: acha a compra no Mercado Livre (ICCID do chip físico ou
// número do pedido do eSIM) e o plano. POST, e não GET, para o CPF não ir parar em URL e log.
export async function POST(request: Request) {
  const ip = ipDaRequisicao(request) ?? 'desconhecido';
  if (!dentroDoLimite(`consulta:${ip}`, 30, 10 * 60_000)) {
    return NextResponse.json({ error: 'Muitas consultas. Aguarde alguns minutos.' }, { status: 429 });
  }

  let corpo: unknown;
  try {
    corpo = await request.json();
  } catch {
    return NextResponse.json({ error: 'Envio inválido.' }, { status: 400 });
  }

  const validado = consultaSchema.safeParse(corpo);
  if (!validado.success) {
    const campos: Record<string, string> = {};
    for (const issue of validado.error.issues) campos[String(issue.path[0] ?? '_')] ??= issue.message;
    return NextResponse.json({ error: 'Confira os campos destacados.', campos }, { status: 422 });
  }

  try {
    return NextResponse.json(await consultar(validado.data));
  } catch (e) {
    console.error('[api/consulta]', (e as Error).message);
    return NextResponse.json({ error: 'Não foi possível consultar agora. Tente de novo.' }, { status: 502 });
  }
}
