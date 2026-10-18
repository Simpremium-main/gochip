import { describe, expect, it } from 'vitest';
import { chaveIccid, cpfValido, formatarCpf, iccidValido, mascararCpf, normalizarTelefone } from '@/lib/documentos';
import { cadastroSchema, chaveDoCampo, consultaSchema, pedidosSchema } from '@/lib/cadastro-schema';

describe('ICCID', () => {
  it('normaliza espaços e caixa como o Pedido Central', () => {
    expect(chaveIccid(' 8955 1234-5678 9012 3456 ')).toBe('89551234567890123456');
  });
  it('aceita 18 a 22 dígitos começando com 89, com F de preenchimento', () => {
    expect(iccidValido('8955 0123 4567 8901 234')).toBe(true);
    expect(iccidValido('89550123456789012345F')).toBe(true);
    expect(iccidValido('1234567890123456789')).toBe(false);
    expect(iccidValido('8955')).toBe(false);
  });
});

describe('CPF', () => {
  it('valida dígitos verificadores', () => {
    expect(cpfValido('529.982.247-25')).toBe(true);
    expect(cpfValido('52998224725')).toBe(true);
    expect(cpfValido('529.982.247-24')).toBe(false);
    expect(cpfValido('111.111.111-11')).toBe(false);
    expect(cpfValido('123')).toBe(false);
  });
  it('formata e mascara', () => {
    expect(formatarCpf('52998224725')).toBe('529.982.247-25');
    expect(formatarCpf('5299')).toBe('529.9');
    expect(mascararCpf('52998224725')).toBe('***.982.247-**');
  });
});

describe('telefone', () => {
  it('põe DDI 55 em número brasileiro', () => {
    expect(normalizarTelefone('(11) 91234-5678')).toBe('5511912345678');
    expect(normalizarTelefone('+1 305 555 0100')).toBe('13055550100');
    expect(normalizarTelefone('1234')).toBeNull();
  });
});

describe('cadastroSchema', () => {
  const chip = { item_id: 678, posicao: 1, travel_start: '2026-10-10', countries: ['Estados Unidos'] };
  const valido = {
    pedido_id: '12345',
    chips: [chip],
    full_name: 'Maria da Silva',
    cpf: '529.982.247-25',
    birth_date: '1990-05-10',
    email: ' Maria@Exemplo.com ',
    phone: '(11) 91234-5678',
    observation: '',
    lgpd: true,
    website: '',
  };
  const campos = (r: { success: boolean; error?: { issues: { path: (string | number)[] }[] } }) =>
    r.success ? [] : r.error!.issues.map((i) => chaveDoCampo(i.path));

  it('aceita e normaliza um envio válido', () => {
    const r = cadastroSchema.parse(valido);
    expect(r.cpf).toBe('52998224725');
    expect(r.phone).toBe('5511912345678');
    expect(r.email).toBe('maria@exemplo.com');
    expect(r.chips[0].item_id).toBe(678);
    expect(r.chips[0].countries).toEqual(['Estados Unidos']);
  });

  it('um titular para vários chips, cada chip com a sua data e os seus países', () => {
    const r = cadastroSchema.parse({
      ...valido,
      chips: [chip, { ...chip, posicao: 2, travel_start: '2026-11-01', countries: ['França', 'França'] }],
    });
    expect(r.chips.map((c) => [c.posicao, c.travel_start, c.countries])).toEqual([
      [1, '2026-10-10', ['Estados Unidos']],
      [2, '2026-11-01', ['França']],
    ]);
  });

  it('aponta o chip do erro: data e países de cada um', () => {
    const r = cadastroSchema.safeParse({ ...valido, chips: [chip, { ...chip, posicao: 2, travel_start: '', countries: [] }] });
    expect(campos(r)).toEqual(expect.arrayContaining(['chips.1.travel_start', 'chips.1.countries']));
  });

  it('exige o pedido escolhido e ao menos um chip; item é opcional', () => {
    expect(campos(cadastroSchema.safeParse({ ...valido, pedido_id: '' }))).toEqual(['pedido_id']);
    expect(campos(cadastroSchema.safeParse({ ...valido, chips: [] }))).toEqual(['chips']);
    expect(cadastroSchema.parse({ ...valido, chips: [{ ...chip, item_id: null }] }).chips[0].item_id).toBeNull();
  });

  it('ICCID não vem do navegador: o que chegar é descartado', () => {
    const r = cadastroSchema.parse({ ...valido, chips: [{ ...chip, iccid: '8955 0123 4567 8901 234' }] });
    expect(r.chips[0]).not.toHaveProperty('iccid');
  });

  it('exige consentimento, nome completo e CPF válido', () => {
    const r = cadastroSchema.safeParse({ ...valido, lgpd: false, full_name: 'Maria', cpf: '000' });
    expect(r.success).toBe(false);
    expect(campos(r)).toEqual(expect.arrayContaining(['lgpd', 'full_name', 'cpf']));
  });

  it('recusa quando a armadilha de robô vem preenchida', () => {
    expect(cadastroSchema.safeParse({ ...valido, website: 'http://spam' }).success).toBe(false);
  });
});

describe('pedidosSchema e consultaSchema', () => {
  it('passo 1 pede só o CPF', () => {
    expect(pedidosSchema.parse({ cpf: '529.982.247-25' }).cpf).toBe('52998224725');
    expect(pedidosSchema.safeParse({ cpf: '123' }).success).toBe(false);
  });
  it('passo 2 pede o CPF e o pedido escolhido', () => {
    expect(consultaSchema.safeParse({ cpf: '52998224725', pedido_id: '12345' }).success).toBe(true);
    const r = consultaSchema.safeParse({ cpf: '52998224725', pedido_id: 'abc' });
    expect(r.success ? [] : r.error.issues.map((i) => i.path[0])).toEqual(['pedido_id']);
  });
});
