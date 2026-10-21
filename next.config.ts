import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  poweredByHeader: false,
  async redirects() {
    return [
      // A raiz leva à loja no Mercado Livre; o cadastro do chip fica em /ativar.
      // Temporário (307) de propósito: um 308 fica gravado no navegador e dificulta mudar o destino depois.
      { source: '/', destination: 'https://www.mercadolivre.com.br/pagina/brasilsim', permanent: false },
    ];
  },
};

export default nextConfig;
