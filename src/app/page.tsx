import { CadastroChip } from '@/components/cadastro-chip';

// Lê WHATSAPP_SUPORTE a cada acesso: trocar o número não exige novo build.
export const dynamic = 'force-dynamic';

/** Número provisório do suporte, usado enquanto WHATSAPP_SUPORTE não estiver configurado. */
const WHATSAPP_SUPORTE_PADRAO = '551149495008';

export default async function Pagina({
  searchParams,
}: {
  searchParams: Promise<{ iccid?: string; pedido?: string }>;
}) {
  // ?iccid=... (QR code na embalagem do chip físico) ou ?pedido=... (link na mensagem do
  // eSIM) abrem a tela com o número preenchido.
  const { iccid, pedido } = await searchParams;
  return (
    <CadastroChip
      iccidInicial={iccid ?? ''}
      pedidoInicial={pedido ?? ''}
      whatsappSuporte={process.env.WHATSAPP_SUPORTE || WHATSAPP_SUPORTE_PADRAO}
    />
  );
}
