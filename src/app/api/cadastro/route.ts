import { NextResponse } from 'next/server';
import { cadastroSchema } from '@/lib/cadastro-schema';
import { CadastroBloqueadoError, CampoInvalidoError, PedidoIndisponivelError, registrarCadastro } from '@/lib/pedido-central';
import { dentroDoLimite, ipDaRequisicao } from '@/lib/limite';

export const dynamic = 'force-dynamic';

// POST /api/cadastro — passo 3: grava os dados do titular no Pedido Central.
export async function POST(request: Request) {
  const ip = ipDaRequisicao(request);
  if (!dentroDoLimite(`cadastro:${ip ?? 'desconhecido'}`, 10, 10 * 60_000)) {
    return NextResponse.json({ error: 'Muitos envios. Aguarde alguns minutos.' }, { status: 429 });
  }

  let corpo: unknown;
  try {
    corpo = await request.json();
  } catch {
    return NextResponse.json({ error: 'Envio inválido.' }, { status: 400 });
  }

  const validado = cadastroSchema.safeParse(corpo);
  if (!validado.success) {
    const campos: Record<string, string> = {};
    for (const issue of validado.error.issues) {
      const campo = String(issue.path[0] ?? '_');
      campos[campo] ??= issue.message;
    }
    return NextResponse.json({ error: 'Confira os campos destacados.', campos }, { status: 422 });
  }

  try {
    const resultado = await registrarCadastro(validado.data, {
      ip,
      userAgent: request.headers.get('user-agent'),
    });
    return NextResponse.json({ success: true, ...resultado });
  } catch (e) {
    if (e instanceof CadastroBloqueadoError) {
      return NextResponse.json({ error: e.message }, { status: 409 });
    }
    if (e instanceof PedidoIndisponivelError) {
      return NextResponse.json({ error: e.message }, { status: 404 });
    }
    if (e instanceof CampoInvalidoError) {
      return NextResponse.json({ error: e.message, campos: e.campos }, { status: 422 });
    }
    console.error('[api/cadastro]', (e as Error).message);
    return NextResponse.json({ error: 'Não foi possível salvar agora. Tente de novo em instantes.' }, { status: 502 });
  }
}
