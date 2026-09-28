import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'GoChip — Cadastro do chip',
  description: 'Recebeu seu chip SimPremium? Cadastre o titular para a ativação.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#0f766e',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="pt-BR">
      <body className="min-h-screen bg-slate-50 font-sans text-slate-900 antialiased">
        <header className="bg-marca text-white">
          <div className="mx-auto max-w-xl px-4 py-4">
            <p className="text-lg font-bold tracking-tight">GoChip</p>
            <p className="text-sm text-white/80">Cadastro do titular — SimPremium</p>
          </div>
        </header>
        <main className="mx-auto max-w-xl px-4 py-6">{children}</main>
      </body>
    </html>
  );
}
