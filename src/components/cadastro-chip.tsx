'use client';

import { useState } from 'react';
import { cadastroSchema, type ConsultaChip, type TipoChip } from '@/lib/cadastro-schema';
import { chaveIccid, formatarCpf, iccidValido } from '@/lib/documentos';

type Etapa = 'chip' | 'formulario' | 'concluido';

interface Formulario {
  full_name: string;
  cpf: string;
  birth_date: string;
  email: string;
  phone: string;
  order_number_informed: string;
  travel_start: string;
  observation: string;
  lgpd: boolean;
  website: string;
}

const VAZIO: Formulario = {
  full_name: '',
  cpf: '',
  birth_date: '',
  email: '',
  phone: '',
  order_number_informed: '',
  travel_start: '',
  observation: '',
  lgpd: false,
  website: '',
};

const TIPO_TEXTO: Record<TipoChip, string> = { fisico: 'Chip físico', virtual: 'eSIM (chip virtual)' };

export function CadastroChip({ iccidInicial }: { iccidInicial: string }) {
  const [etapa, setEtapa] = useState<Etapa>('chip');
  const [iccid, setIccid] = useState(iccidInicial);
  const [tipo, setTipo] = useState<TipoChip>('fisico');
  const [consulta, setConsulta] = useState<ConsultaChip | null>(null);
  const [form, setForm] = useState<Formulario>(VAZIO);
  const [erros, setErros] = useState<Record<string, string>>({});
  const [erroGeral, setErroGeral] = useState<string | null>(null);
  const [carregando, setCarregando] = useState(false);
  const [resultado, setResultado] = useState<{ atualizado: boolean; vinculadoAoPedido: boolean } | null>(null);

  const alterar = <K extends keyof Formulario>(campo: K, valor: Formulario[K]) => {
    setForm((f) => ({ ...f, [campo]: valor }));
    setErros(({ [campo]: _, ...resto }) => resto);
  };

  async function consultar(e: React.FormEvent) {
    e.preventDefault();
    setErroGeral(null);
    if (!iccidValido(iccid)) {
      setErros({ iccid: 'ICCID inválido. Ele tem de 18 a 22 dígitos e começa com 89.' });
      return;
    }
    setCarregando(true);
    try {
      const res = await fetch(`/api/chip?iccid=${encodeURIComponent(chaveIccid(iccid))}`);
      const dados = await res.json();
      if (!res.ok) throw new Error(dados.error || 'Falha na consulta');
      const c = dados as ConsultaChip;
      if (c.bloqueado) {
        setErroGeral('Este chip já foi cadastrado e conferido pela nossa equipe. Para alterar algum dado, fale com o suporte.');
        return;
      }
      setConsulta(c);
      if (c.tipo) setTipo(c.tipo);
      setErros({});
      setEtapa('formulario');
    } catch (err) {
      setErroGeral((err as Error).message);
    } finally {
      setCarregando(false);
    }
  }

  async function enviar(e: React.FormEvent) {
    e.preventDefault();
    setErroGeral(null);
    const corpo = { ...form, iccid: chaveIccid(iccid), chip_type: tipo };

    const local = cadastroSchema.safeParse(corpo);
    if (!local.success) {
      const campos: Record<string, string> = {};
      for (const issue of local.error.issues) campos[String(issue.path[0])] ??= issue.message;
      setErros(campos);
      setErroGeral('Confira os campos destacados.');
      return;
    }

    setCarregando(true);
    try {
      const res = await fetch('/api/cadastro', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(corpo),
      });
      const dados = await res.json();
      if (!res.ok) {
        if (dados.campos) setErros(dados.campos);
        throw new Error(dados.error || 'Falha ao enviar');
      }
      setResultado({ atualizado: dados.atualizado, vinculadoAoPedido: dados.vinculadoAoPedido });
      setEtapa('concluido');
    } catch (err) {
      setErroGeral((err as Error).message);
    } finally {
      setCarregando(false);
    }
  }

  function recomecar() {
    setEtapa('chip');
    setIccid('');
    setConsulta(null);
    setForm(VAZIO);
    setErros({});
    setErroGeral(null);
    setResultado(null);
  }

  const classeCampo = (campo: string) => `campo ${erros[campo] ? 'campo-erro' : ''}`;
  const Erro = ({ campo }: { campo: string }) =>
    erros[campo] ? <p className="mt-1 text-sm text-red-600">{erros[campo]}</p> : null;

  return (
    <div className="space-y-6">
      <Passos etapa={etapa} />

      {erroGeral && (
        <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {erroGeral}
        </div>
      )}

      {etapa === 'chip' && (
        <form onSubmit={consultar} className="space-y-4 rounded-xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
          <div>
            <h1 className="text-xl font-semibold">Recebeu seu chip?</h1>
            <p className="mt-1 text-sm text-slate-600">
              Digite o número do chip (ICCID). No chip físico ele está impresso no cartão, abaixo do código de
              barras. No eSIM ele vem no e-mail com o QR code.
            </p>
          </div>
          <div>
            <label htmlFor="iccid" className="rotulo">Número do chip (ICCID)</label>
            <input
              id="iccid"
              inputMode="numeric"
              autoComplete="off"
              placeholder="8955 0000 0000 0000 000"
              className={`${classeCampo('iccid')} font-mono tracking-wider`}
              value={iccid}
              onChange={(e) => {
                setIccid(e.target.value);
                setErros({});
              }}
            />
            <Erro campo="iccid" />
          </div>
          <button type="submit" className="botao" disabled={carregando || !iccid.trim()}>
            {carregando ? 'Consultando…' : 'Continuar'}
          </button>
        </form>
      )}

      {etapa === 'formulario' && consulta && (
        <form onSubmit={enviar} noValidate className="space-y-5 rounded-xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
          <div className="rounded-lg bg-marca-claro/60 px-4 py-3 text-sm">
            <p className="font-mono font-medium">{consulta.iccid}</p>
            {consulta.encontrado ? (
              <p className="text-slate-700">
                {TIPO_TEXTO[tipo]}
                {consulta.pedidoFinal && <> — pedido terminado em <strong>{consulta.pedidoFinal}</strong></>}
              </p>
            ) : (
              <p className="text-slate-700">
                Ainda não localizamos este chip em um pedido. Tudo bem: envie o cadastro e nossa equipe faz o
                vínculo.
              </p>
            )}
            {consulta.jaCadastrado && (
              <p className="mt-1 text-amber-800">
                Já recebemos um cadastro deste chip. Enviar de novo substitui os dados anteriores.
              </p>
            )}
            <button type="button" onClick={recomecar} className="mt-2 text-sm font-medium text-marca underline">
              Trocar número do chip
            </button>
          </div>

          {!consulta.encontrado && (
            <>
              <fieldset>
                <legend className="rotulo">Tipo de chip</legend>
                <div className="grid grid-cols-2 gap-2">
                  {(['fisico', 'virtual'] as TipoChip[]).map((t) => (
                    <label
                      key={t}
                      className={`cursor-pointer rounded-lg border px-3 py-2.5 text-center text-sm font-medium ${
                        tipo === t ? 'border-marca bg-marca-claro/60 text-marca-escuro' : 'border-slate-300'
                      }`}
                    >
                      <input type="radio" name="tipo" className="sr-only" checked={tipo === t} onChange={() => setTipo(t)} />
                      {TIPO_TEXTO[t]}
                    </label>
                  ))}
                </div>
              </fieldset>
              <div>
                <label htmlFor="order_number_informed" className="rotulo">Número do pedido (se souber)</label>
                <input
                  id="order_number_informed"
                  inputMode="numeric"
                  className={classeCampo('order_number_informed')}
                  value={form.order_number_informed}
                  onChange={(e) => alterar('order_number_informed', e.target.value)}
                />
                <Erro campo="order_number_informed" />
              </div>
            </>
          )}

          <h2 className="text-lg font-semibold">Dados do titular</h2>

          <div>
            <label htmlFor="full_name" className="rotulo">Nome completo *</label>
            <input
              id="full_name"
              autoComplete="name"
              className={classeCampo('full_name')}
              value={form.full_name}
              onChange={(e) => alterar('full_name', e.target.value)}
            />
            <Erro campo="full_name" />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="cpf" className="rotulo">CPF *</label>
              <input
                id="cpf"
                inputMode="numeric"
                placeholder="000.000.000-00"
                className={classeCampo('cpf')}
                value={form.cpf}
                onChange={(e) => alterar('cpf', formatarCpf(e.target.value))}
              />
              <Erro campo="cpf" />
            </div>
            <div>
              <label htmlFor="birth_date" className="rotulo">Data de nascimento</label>
              <input
                id="birth_date"
                type="date"
                autoComplete="bday"
                className={classeCampo('birth_date')}
                value={form.birth_date}
                onChange={(e) => alterar('birth_date', e.target.value)}
              />
              <Erro campo="birth_date" />
            </div>
          </div>

          <div>
            <label htmlFor="phone" className="rotulo">Telefone / WhatsApp *</label>
            <input
              id="phone"
              type="tel"
              autoComplete="tel"
              placeholder="(11) 91234-5678"
              className={classeCampo('phone')}
              value={form.phone}
              onChange={(e) => alterar('phone', e.target.value)}
            />
            <Erro campo="phone" />
          </div>

          <div>
            <label htmlFor="email" className="rotulo">E-mail *</label>
            <input
              id="email"
              type="email"
              autoComplete="email"
              className={classeCampo('email')}
              value={form.email}
              onChange={(e) => alterar('email', e.target.value)}
            />
            <Erro campo="email" />
          </div>

          <div>
            <label htmlFor="travel_start" className="rotulo">Quando pretende começar a usar?</label>
            <input
              id="travel_start"
              type="date"
              className={classeCampo('travel_start')}
              value={form.travel_start}
              onChange={(e) => alterar('travel_start', e.target.value)}
            />
            <Erro campo="travel_start" />
          </div>

          <div>
            <label htmlFor="observation" className="rotulo">Observações</label>
            <textarea
              id="observation"
              rows={3}
              className={classeCampo('observation')}
              value={form.observation}
              onChange={(e) => alterar('observation', e.target.value)}
            />
            <Erro campo="observation" />
          </div>

          {/* Armadilha para robôs: invisível para pessoas. */}
          <input
            type="text"
            name="website"
            tabIndex={-1}
            autoComplete="off"
            aria-hidden="true"
            className="hidden"
            value={form.website}
            onChange={(e) => alterar('website', e.target.value)}
          />

          <div>
            <label className="flex items-start gap-3 text-sm text-slate-700">
              <input
                type="checkbox"
                className="mt-0.5 h-5 w-5 accent-marca"
                checked={form.lgpd}
                onChange={(e) => alterar('lgpd', e.target.checked)}
              />
              <span>
                Autorizo a SimPremium a usar estes dados para ativar e dar suporte à linha, conforme a LGPD.
              </span>
            </label>
            <Erro campo="lgpd" />
          </div>

          <button type="submit" className="botao" disabled={carregando}>
            {carregando ? 'Enviando…' : 'Enviar cadastro'}
          </button>
        </form>
      )}

      {etapa === 'concluido' && resultado && (
        <div className="space-y-4 rounded-xl bg-white p-6 text-center shadow-sm ring-1 ring-slate-200">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-marca-claro text-2xl text-marca">
            ✓
          </div>
          <h1 className="text-xl font-semibold">
            {resultado.atualizado ? 'Cadastro atualizado!' : 'Cadastro recebido!'}
          </h1>
          <p className="text-sm text-slate-600">
            {resultado.vinculadoAoPedido
              ? 'Os dados já estão no seu pedido. Nossa equipe confere e segue com a ativação.'
              : 'Nossa equipe vai localizar o seu pedido e seguir com a ativação.'}
          </p>
          <button type="button" onClick={recomecar} className="botao-secundario w-full">
            Cadastrar outro chip
          </button>
        </div>
      )}
    </div>
  );
}

function Passos({ etapa }: { etapa: Etapa }) {
  const itens: { chave: Etapa; texto: string }[] = [
    { chave: 'chip', texto: 'Chip' },
    { chave: 'formulario', texto: 'Dados' },
    { chave: 'concluido', texto: 'Pronto' },
  ];
  const atual = itens.findIndex((i) => i.chave === etapa);
  return (
    <ol className="flex items-center gap-2 text-sm">
      {itens.map((item, i) => (
        <li key={item.chave} className="flex flex-1 items-center gap-2">
          <span
            className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
              i <= atual ? 'bg-marca text-white' : 'bg-slate-200 text-slate-500'
            }`}
          >
            {i + 1}
          </span>
          <span className={i <= atual ? 'font-medium text-slate-900' : 'text-slate-500'}>{item.texto}</span>
          {i < itens.length - 1 && <span className="h-px flex-1 bg-slate-200" />}
        </li>
      ))}
    </ol>
  );
}
