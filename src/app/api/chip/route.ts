import { NextResponse } from 'next/server';
import { iccidValido } from '@/lib/documentos';
import { consultarChip } from '@/lib/pedido-central';
import { dentroDoLimite, ipDaRequisicao } from '@/lib/limite';

export const dynamic = 'force-dynamic';

// GET /api/chip?iccid=...  — passo 1: o chip existe em algum pedido? já foi cadastrado?
export async function GET(request: Request) {
  const ip = ipDaRequisicao(request) ?? 'desconhecido';
  if (!dentroDoLimite(`chip:${ip}`, 30, 10 * 60_000)) {
    return NextResponse.json({ error: 'Muitas consultas. Aguarde alguns minutos.' }, { status: 429 });
  }

  const iccid = new URL(request.url).searchParams.get('iccid') || '';
  if (!iccidValido(iccid)) {
    return NextResponse.json(
      { error: 'ICCID inválido. Ele tem de 18 a 22 dígitos e começa com 89.' },
      { status: 400 },
    );
  }

  try {
    return NextResponse.json(await consultarChip(iccid));
  } catch (e) {
    console.error('[api/chip]', (e as Error).message);
    return NextResponse.json({ error: 'Não foi possível consultar o chip agora. Tente de novo.' }, { status: 502 });
  }
}
