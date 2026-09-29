import { CadastroChip } from '@/components/cadastro-chip';

export default async function Pagina({
  searchParams,
}: {
  searchParams: Promise<{ iccid?: string; pedido?: string }>;
}) {
  // ?iccid=... (QR code na embalagem do chip físico) ou ?pedido=... (link na mensagem do
  // eSIM) abrem a tela com o número preenchido.
  const { iccid, pedido } = await searchParams;
  return <CadastroChip iccidInicial={iccid ?? ''} pedidoInicial={pedido ?? ''} />;
}
