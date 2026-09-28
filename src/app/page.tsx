import { CadastroChip } from '@/components/cadastro-chip';

export default async function Pagina({
  searchParams,
}: {
  searchParams: Promise<{ iccid?: string }>;
}) {
  // ?iccid=... permite um link/QR code que já abre com o número preenchido.
  const { iccid } = await searchParams;
  return <CadastroChip iccidInicial={iccid ?? ''} />;
}
