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
          DEFAULT: '#4646e6',
          escuro: '#3535c9',
          profundo: '#2c2b8a',
          claro: '#eff0fd',
          borda: '#cfd2f8',
        },
        fundo: '#3a3a9e',
      },
      boxShadow: {
        cartao: '0 30px 60px -30px rgba(12, 12, 60, 0.45)',
      },
    },
  },
  plugins: [],
} satisfies Config;
