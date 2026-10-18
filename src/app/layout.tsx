import type { Metadata, Viewport } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';

const fonte = Inter({ subsets: ['latin'], weight: ['300', '400', '500', '600'], variable: '--fonte', display: 'swap' });

export const metadata: Metadata = {
  title: 'GoChip — Ativação do chip',
  description: 'Comprou seu chip no Mercado Livre? Cadastre os dados para a ativação.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#3a3a9e',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="pt-BR" className={fonte.variable}>
      <body className="min-h-screen font-sans text-slate-900 antialiased">
        <header className="mx-auto flex max-w-5xl items-center gap-2.5 px-4 pb-5 pt-6 text-white sm:pt-10">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-white/15 ring-1 ring-inset ring-white/25">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" className="h-[18px] w-[18px]" aria-hidden="true">
              <path d="M8 3h6.5L19 7.5V19a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z" strokeLinejoin="round" />
              <rect x="9" y="11" width="7" height="6" rx="1" />
            </svg>
          </span>
          <p className="text-[15px] font-medium tracking-tight">GoChip</p>
          <span className="text-sm font-light text-white/60">· Ativação do seu chip</span>
        </header>
        <main className="mx-auto max-w-5xl px-4 pb-8">{children}</main>
        <footer className="mx-auto max-w-5xl px-4 pb-8 text-center text-xs font-light text-white/60">
          GoChip · Seus dados são usados apenas para a ativação, conforme a LGPD.
        </footer>
      </body>
    </html>
  );
}
