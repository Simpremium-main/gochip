import type { Metadata, Viewport } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';

const fonte = Inter({ subsets: ['latin'], variable: '--fonte', display: 'swap' });

export const metadata: Metadata = {
  title: 'GoChip — Ativação do chip',
  description: 'Comprou seu chip SimPremium no Mercado Livre? Cadastre os dados para a ativação.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#ffffff',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="pt-BR" className={fonte.variable}>
      <body className="min-h-screen font-sans text-slate-900 antialiased">
        <header className="border-b border-slate-200/70 bg-white/80 backdrop-blur">
          <div className="mx-auto flex max-w-xl items-center gap-3 px-4 py-3.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-marca to-marca-profundo text-white shadow-sm shadow-marca/30">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-5 w-5" aria-hidden="true">
                <path d="M8 3h6.5L19 7.5V19a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z" strokeLinejoin="round" />
                <rect x="9" y="11" width="7" height="6" rx="1" />
                <path d="M12.5 11v6M9 14h7" />
              </svg>
            </span>
            <div className="leading-tight">
              <p className="text-[15px] font-semibold tracking-tight">GoChip</p>
              <p className="text-xs text-slate-500">Ativação SimPremium</p>
            </div>
          </div>
        </header>
        <main className="mx-auto max-w-xl px-4 pb-10 pt-6 sm:pt-10">{children}</main>
        <footer className="mx-auto max-w-xl px-4 pb-8 text-center text-xs text-slate-400">
          SimPremium · Seus dados são usados apenas para a ativação, conforme a LGPD.
        </footer>
      </body>
    </html>
  );
}
