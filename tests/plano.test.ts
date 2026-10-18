import { describe, expect, it } from 'vitest';
import { fimDaVigencia, formatarDataBR, formatarFranquia, lerTitulo, tipoDoTitulo } from '@/lib/plano';

describe('lerTitulo', () => {
  it('extrai destino, dias e franquia do título do Mercado Livre', () => {
    expect(lerTitulo('Chip Virtual Esim Estados Unidos 30 Dias 3gb - Internet Esim')).toEqual({
      titulo: 'Chip Virtual Esim Estados Unidos 30 Dias 3gb - Internet Esim',
      destino: 'Estados Unidos',
      dias: 30,
      franquia: '3GB',
    });
  });

  it('lê o formato gerado pela Tabela de Preço', () => {
    const r = lerTitulo('Chip Esim Europa 33 Países - 5GB - 15 dias');
    expect(r).toMatchObject({ destino: 'Europa', dias: 15, franquia: '5GB' });
  });

  it('mantém acentos e regiões compostas no destino', () => {
    const r = lerTitulo('Chip Virtual Esim Europa + Turquia 15 Dias - Pacote Diário Esim');
    expect(r).toMatchObject({ destino: 'Europa + Turquia', dias: 15, franquia: 'Pacote diário' });
    expect(lerTitulo('Chip Japão - 1GB/dia - 7 dias')).toMatchObject({ destino: 'Japão', dias: 7, franquia: '1GB/dia' });
    expect(lerTitulo('Chip Físico Canadá Ilimitado 10 dias')).toMatchObject({ destino: 'Canadá', franquia: 'Ilimitado' });
  });
});

describe('vigência', () => {
  it('conta o dia da ativação como o primeiro', () => {
    expect(fimDaVigencia('2026-10-10', 30)).toBe('2026-11-08');
    expect(fimDaVigencia('2026-12-31', 1)).toBe('2026-12-31');
    expect(fimDaVigencia('2026-02-20', 15)).toBe('2026-03-06');
  });
  it('sem data ou sem período, não há fim', () => {
    expect(fimDaVigencia('', 30)).toBeNull();
    expect(fimDaVigencia('2026-10-10', null)).toBeNull();
  });
  it('formata em dd/mm/aaaa', () => {
    expect(formatarDataBR('2026-11-08')).toBe('08/11/2026');
  });
});

describe('formatarFranquia', () => {
  it('acrescenta /dia só no plano diário que ainda não diz', () => {
    expect(formatarFranquia('3 GB')).toBe('3GB');
    expect(formatarFranquia('500MB', true)).toBe('500MB/dia');
    expect(formatarFranquia('1GB/dia', true)).toBe('1GB/dia');
    expect(formatarFranquia('Unlimited')).toBe('Ilimitado');
    expect(formatarFranquia('', true)).toBe('Pacote diário');
  });
});

describe('tipoDoTitulo', () => {
  it('reconhece eSIM e chip físico pelo título', () => {
    expect(tipoDoTitulo('Chip Virtual Esim Estados Unidos 30 Dias 3gb - Internet Esim')).toBe('virtual');
    expect(tipoDoTitulo('Chip E-SIM Europa 15 dias')).toBe('virtual');
    expect(tipoDoTitulo('Chip Físico Europa 33 Países - 5GB')).toBe('fisico');
    expect(tipoDoTitulo('Chip Internacional Estados Unidos 30 Dias')).toBe('fisico');
  });
});
