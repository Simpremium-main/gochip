import type { Config } from 'tailwindcss';

export default {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        marca: {
          DEFAULT: '#0f766e',
          escuro: '#115e59',
          claro: '#ccfbf1',
        },
      },
    },
  },
  plugins: [],
} satisfies Config;
