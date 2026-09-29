import type { Config } from 'tailwindcss';

export default {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['var(--fonte)', 'ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
      },
      colors: {
        marca: {
          DEFAULT: '#2563eb',
          escuro: '#1d4ed8',
          profundo: '#1e3a8a',
          claro: '#eff6ff',
          borda: '#bfdbfe',
        },
      },
      boxShadow: {
        cartao: '0 1px 2px rgba(15, 23, 42, 0.04), 0 8px 24px -12px rgba(15, 23, 42, 0.12)',
      },
    },
  },
  plugins: [],
} satisfies Config;
