/**
 * Validação e formatação dos documentos que o cliente digita.
 * Tudo aqui é puro (sem rede): roda igual no navegador e no servidor.
 */

export const soDigitos = (v: unknown): string => String(v ?? '').replace(/\D/g, '');

/**
 * ICCID reduzido ao que ele é: só letras e dígitos, em maiúsculas.
 * É a mesma regra de `chaveIccid` do Pedido Central — as duas pontas precisam
 * escrever o chip do mesmo jeito para o cruzamento com a mestre funcionar.
 */
export const chaveIccid = (v: unknown): string =>
  String(v ?? '').toUpperCase().replace(/[^0-9A-Z]/g, '');

/**
 * ICCID plausível: 18 a 22 dígitos começando por 89 (prefixo de telecom da ISO 7812).
 * Alguns chips trazem um "F" de preenchimento no fim; ele é aceito e descartado.
 */
export function iccidValido(v: unknown): boolean {
  const chave = chaveIccid(v).replace(/F$/, '');
  return /^89\d{16,20}$/.test(chave);
}

/** CPF com dígitos verificadores corretos. Rejeita sequências repetidas (111.111.111-11). */
export function cpfValido(v: unknown): boolean {
  const cpf = soDigitos(v);
  if (cpf.length !== 11 || /^(\d)\1{10}$/.test(cpf)) return false;
  const digito = (base: string, pesoInicial: number) => {
    let soma = 0;
    for (let i = 0; i < base.length; i++) soma += Number(base[i]) * (pesoInicial - i);
    const resto = (soma * 10) % 11;
    return resto === 10 ? 0 : resto;
  };
  return digito(cpf.slice(0, 9), 10) === Number(cpf[9])
    && digito(cpf.slice(0, 10), 11) === Number(cpf[10]);
}

export function formatarCpf(v: unknown): string {
  const d = soDigitos(v).slice(0, 11);
  return d
    .replace(/^(\d{3})(\d)/, '$1.$2')
    .replace(/^(\d{3})\.(\d{3})(\d)/, '$1.$2.$3')
    .replace(/\.(\d{3})(\d{1,2})$/, '.$1-$2');
}

/** CPF mascarado para logs: ***.456.789-** */
export function mascararCpf(v: unknown): string {
  const d = soDigitos(v);
  if (d.length !== 11) return '***';
  return `***.${d.slice(3, 6)}.${d.slice(6, 9)}-**`;
}

/**
 * Telefone de contato normalizado com DDI.
 * Escrito com "+" na frente, o DDI já está ali e o número é mantido. Sem "+", número
 * brasileiro (10 ou 11 dígitos) ganha o 55. Devolve null quando não dá para ser um telefone.
 */
export function normalizarTelefone(v: unknown): string | null {
  const d = soDigitos(v);
  if (String(v ?? '').trim().startsWith('+')) return d.length >= 8 && d.length <= 15 ? d : null;
  if (d.length === 10 || d.length === 11) return `55${d}`;
  if (d.length >= 12 && d.length <= 15) return d;
  return null;
}
