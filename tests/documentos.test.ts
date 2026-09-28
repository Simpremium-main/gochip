import { describe, expect, it } from 'vitest';
import { chaveIccid, cpfValido, formatarCpf, iccidValido, mascararCpf, normalizarTelefone } from '@/lib/documentos';
import { cadastroSchema } from '@/lib/cadastro-schema';

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
  const valido = {
    iccid: '8955 0123 4567 8901 234',
    chip_type: 'fisico',
    full_name: 'Maria da Silva',
    cpf: '529.982.247-25',
    birth_date: '1990-05-10',
    email: ' Maria@Exemplo.com ',
    phone: '(11) 91234-5678',
    order_number_informed: '',
    travel_start: '',
    observation: '',
    lgpd: true,
    website: '',
  };

  it('aceita e normaliza um envio válido', () => {
    const r = cadastroSchema.parse(valido);
    expect(r.cpf).toBe('52998224725');
    expect(r.phone).toBe('5511912345678');
    expect(r.email).toBe('maria@exemplo.com');
    expect(r.travel_start).toBeUndefined();
  });

  it('exige consentimento, nome completo e CPF válido', () => {
    const r = cadastroSchema.safeParse({ ...valido, lgpd: false, full_name: 'Maria', cpf: '000' });
    expect(r.success).toBe(false);
    const campos = r.success ? [] : r.error.issues.map((i) => i.path[0]);
    expect(campos).toEqual(expect.arrayContaining(['lgpd', 'full_name', 'cpf']));
  });

  it('recusa quando a armadilha de robô vem preenchida', () => {
    expect(cadastroSchema.safeParse({ ...valido, website: 'http://spam' }).success).toBe(false);
  });
});
