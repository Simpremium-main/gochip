'use client';

import { useMemo, useState } from 'react';
import { cadastroSchema, consultaSchema, type Consulta, type TipoChip } from '@/lib/cadastro-schema';
import { chaveIccid, formatarCpf, soDigitos } from '@/lib/documentos';
import { chaveTexto, fimDaVigencia, formatarDataBR, paisesDaLista, type PlanoComprado } from '@/lib/plano';

type Etapa = 'chip' | 'formulario' | 'concluido';

interface Formulario {
  full_name: string;
  birth_date: string;
  email: string;
  phone: string;
  order_number: string;
  travel_start: string;
  countries: string[];
  /** Países digitados à mão, quando a cobertura do plano não é conhecida. */
  countries_texto: string;
  observation: string;
  lgpd: boolean;
  website: string;
}

const VAZIO: Formulario = {
  full_name: '',
  birth_date: '',
  email: '',
  phone: '',
  order_number: '',
  travel_start: '',
  countries: [],
  countries_texto: '',
  observation: '',
  lgpd: false,
  website: '',
};

const TIPO_TEXTO: Record<TipoChip, string> = { fisico: 'Chip físico', virtual: 'eSIM (chip virtual)' };

const hojeIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

function lerCampos(issues: { path: (string | number)[]; message: string }[]) {
  const campos: Record<string, string> = {};
  for (const issue of issues) campos[String(issue.path[0] ?? '_')] ??= issue.message;
  return campos;
}

export function CadastroChip({ iccidInicial, pedidoInicial }: { iccidInicial: string; pedidoInicial: string }) {
  const [etapa, setEtapa] = useState<Etapa>('chip');
  const [tipo, setTipo] = useState<TipoChip>(pedidoInicial && !iccidInicial ? 'virtual' : 'fisico');
  const [iccid, setIccid] = useState(iccidInicial);
  const [pedido, setPedido] = useState(pedidoInicial);
  const [cpf, setCpf] = useState('');
  const [consulta, setConsulta] = useState<Consulta | null>(null);
  const [form, setForm] = useState<Formulario>(VAZIO);
  const [filtroPais, setFiltroPais] = useState('');
  const [erros, setErros] = useState<Record<string, string>>({});
  const [erroGeral, setErroGeral] = useState<string | null>(null);
  const [carregando, setCarregando] = useState(false);
  const [resultado, setResultado] = useState<{ atualizado: boolean; vinculadoAoPedido: boolean; vigenciaFim: string | null } | null>(null);

  const plano = consulta?.plano ?? null;
  const cobertura = plano?.paises ?? [];

  const alterar = <K extends keyof Formulario>(campo: K, valor: Formulario[K]) => {
    setForm((f) => ({ ...f, [campo]: valor }));
    const chave = campo === 'countries_texto' ? 'countries' : campo;
    setErros(({ [chave]: _, ...resto }) => resto);
  };

  function alternarPais(pais: string) {
    alterar('countries', form.countries.includes(pais) ? form.countries.filter((p) => p !== pais) : [...form.countries, pais]);
  }

  async function consultar(e: React.FormEvent) {
    e.preventDefault();
    setErroGeral(null);
    const corpo = { chip_type: tipo, iccid: tipo === 'fisico' ? chaveIccid(iccid) : undefined, order_number: tipo === 'virtual' ? pedido : undefined, cpf };
    const local = consultaSchema.safeParse(corpo);
    if (!local.success) {
      setErros(lerCampos(local.error.issues));
      return;
    }
    setCarregando(true);
    try {
      const res = await fetch('/api/consulta', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(corpo),
      });
      const dados = await res.json();
      if (!res.ok) {
        if (dados.campos) setErros(dados.campos);
        throw new Error(dados.error || 'Falha na consulta');
      }
      const c = dados as Consulta;
      if (c.bloqueado) {
        setErroGeral('Este chip já foi cadastrado e conferido pela nossa equipe. Para alterar algum dado, fale com o suporte.');
        return;
      }
      const p = c.preenchimento;
      setConsulta(c);
      setForm({
        ...VAZIO,
        ...(p ? { full_name: p.full_name, email: p.email, phone: p.phone, birth_date: p.birth_date, travel_start: p.travel_start } : {}),
        countries: p?.countries.length ? p.countries : c.plano?.paises.length === 1 ? c.plano.paises : [],
        order_number: tipo === 'virtual' ? soDigitos(pedido) : '',
      });
      setFiltroPais('');
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
    const { countries_texto, countries, order_number, ...resto } = form;
    const corpo = {
      ...resto,
      chip_type: tipo,
      iccid: tipo === 'fisico' ? chaveIccid(iccid) : undefined,
      order_number: order_number || undefined,
      cpf,
      countries: cobertura.length ? countries : paisesDaLista(countries_texto),
    };

    const local = cadastroSchema.safeParse(corpo);
    if (!local.success) {
      setErros(lerCampos(local.error.issues));
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
      setResultado({ atualizado: dados.atualizado, vinculadoAoPedido: dados.vinculadoAoPedido, vigenciaFim: dados.vigenciaFim });
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
    setPedido('');
    setConsulta(null);
    setForm(VAZIO);
    setErros({});
    setErroGeral(null);
    setResultado(null);
  }

  const vigenciaFim = fimDaVigencia(form.travel_start, plano?.dias);
  const paisesVisiveis = useMemo(() => {
    const f = chaveTexto(filtroPais);
    return f ? cobertura.filter((p) => chaveTexto(p).includes(f)) : cobertura;
  }, [cobertura, filtroPais]);

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
        <form onSubmit={consultar} noValidate className="space-y-4 rounded-xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
          <div>
            <h1 className="text-xl font-semibold">Ative seu chip</h1>
            <p className="mt-1 text-sm text-slate-600">
              Vamos localizar a sua compra no Mercado Livre e o plano que você comprou.
            </p>
          </div>

          <fieldset>
            <legend className="rotulo">Qual chip você comprou?</legend>
            <div className="grid grid-cols-2 gap-2">
              {(['fisico', 'virtual'] as TipoChip[]).map((t) => (
                <label
                  key={t}
                  className={`cursor-pointer rounded-lg border px-3 py-2.5 text-center text-sm font-medium ${
                    tipo === t ? 'border-marca bg-marca-claro/60 text-marca-escuro' : 'border-slate-300'
                  }`}
                >
                  <input
                    type="radio"
                    name="tipo"
                    className="sr-only"
                    checked={tipo === t}
                    onChange={() => {
                      setTipo(t);
                      setErros({});
                    }}
                  />
                  {TIPO_TEXTO[t]}
                </label>
              ))}
            </div>
          </fieldset>

          {tipo === 'fisico' ? (
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
                  setErros(({ iccid: _, ...r }) => r);
                }}
              />
              <p className="mt-1 text-xs text-slate-500">Impresso no cartão do chip, abaixo do código de barras.</p>
              <Erro campo="iccid" />
            </div>
          ) : (
            <div>
              <label htmlFor="order_number" className="rotulo">Número do pedido no Mercado Livre</label>
              <input
                id="order_number"
                inputMode="numeric"
                autoComplete="off"
                placeholder="2000 0000 0000 0000"
                className={`${classeCampo('order_number')} font-mono tracking-wider`}
                value={pedido}
                onChange={(e) => {
                  setPedido(e.target.value);
                  setErros(({ order_number: _, ...r }) => r);
                }}
              />
              <p className="mt-1 text-xs text-slate-500">No app do Mercado Livre: Minhas compras → detalhe da compra.</p>
              <Erro campo="order_number" />
            </div>
          )}

          <div>
            <label htmlFor="cpf" className="rotulo">CPF de quem vai usar o chip</label>
            <input
              id="cpf"
              inputMode="numeric"
              placeholder="000.000.000-00"
              className={classeCampo('cpf')}
              value={cpf}
              onChange={(e) => {
                setCpf(formatarCpf(e.target.value));
                setErros(({ cpf: _, ...r }) => r);
              }}
            />
            <Erro campo="cpf" />
          </div>

          <button type="submit" className="botao" disabled={carregando}>
            {carregando ? 'Consultando…' : 'Continuar'}
          </button>
        </form>
      )}

      {etapa === 'formulario' && consulta && (
        <form onSubmit={enviar} noValidate className="space-y-5 rounded-xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
          <div className="rounded-lg bg-marca-claro/60 px-4 py-3 text-sm">
            <p className="font-medium">
              {TIPO_TEXTO[tipo]}
              {consulta.iccid && <span className="ml-2 font-mono">{consulta.iccid}</span>}
            </p>
            {consulta.encontrado ? (
              <p className="text-slate-700">Pedido do Mercado Livre terminado em <strong>{consulta.pedidoFinal}</strong></p>
            ) : (
              <p className="text-slate-700">
                Ainda não localizamos {tipo === 'fisico' ? 'este chip' : 'este pedido'} no Mercado Livre. Tudo bem:
                envie o cadastro e nossa equipe faz o vínculo.
              </p>
            )}
            {consulta.jaCadastrado && (
              <p className="mt-1 text-amber-800">Já recebemos um cadastro deste chip. Enviar de novo substitui os dados anteriores.</p>
            )}
            <button type="button" onClick={recomecar} className="mt-2 text-sm font-medium text-marca underline">
              Trocar chip ou pedido
            </button>
          </div>

          {plano && <CartaoPlano plano={plano} />}

          {!consulta.encontrado && tipo === 'fisico' && (
            <div>
              <label htmlFor="order_number_informado" className="rotulo">Número do pedido no Mercado Livre (se souber)</label>
              <input
                id="order_number_informado"
                inputMode="numeric"
                className={classeCampo('order_number')}
                value={form.order_number}
                onChange={(e) => alterar('order_number', e.target.value)}
              />
              <Erro campo="order_number" />
            </div>
          )}

          <h2 className="text-lg font-semibold">Dados do titular</h2>
          {consulta.preenchimento && (
            <p className="-mt-3 text-sm text-slate-600">Preenchemos com os dados da compra. Confira e corrija se preciso.</p>
          )}

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
              <span className="rotulo">CPF</span>
              <p className="campo bg-slate-50 text-slate-700">{cpf}</p>
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

          <h2 className="text-lg font-semibold">Ativação</h2>

          <div>
            <label htmlFor="travel_start" className="rotulo">Data de ativação *</label>
            <input
              id="travel_start"
              type="date"
              min={hojeIso()}
              className={classeCampo('travel_start')}
              value={form.travel_start}
              onChange={(e) => alterar('travel_start', e.target.value)}
            />
            <Erro campo="travel_start" />
            {vigenciaFim && (
              <p className="mt-2 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
                Seu plano vale de <strong>{formatarDataBR(form.travel_start)}</strong> até{' '}
                <strong>{formatarDataBR(vigenciaFim)}</strong> ({plano!.dias} dias).
              </p>
            )}
          </div>

          <div>
            <span className="rotulo">Países que vai visitar *</span>
            {cobertura.length === 1 ? (
              <p className="text-sm text-slate-700">
                Seu plano cobre <strong>{cobertura[0]}</strong>.
              </p>
            ) : cobertura.length > 1 ? (
              <div className={`rounded-lg border p-3 ${erros.countries ? 'border-red-400' : 'border-slate-300'}`}>
                <p className="mb-2 text-xs text-slate-500">
                  Seu plano cobre {cobertura.length} países. Marque os que vai visitar
                  {form.countries.length > 0 && <> ({form.countries.length} marcado{form.countries.length > 1 ? 's' : ''})</>}.
                </p>
                {cobertura.length > 8 && (
                  <input
                    type="search"
                    placeholder="Buscar país"
                    className="campo mb-2"
                    value={filtroPais}
                    onChange={(e) => setFiltroPais(e.target.value)}
                  />
                )}
                <div className="grid max-h-64 grid-cols-1 gap-1 overflow-y-auto sm:grid-cols-2">
                  {paisesVisiveis.map((p) => (
                    <label key={p} className="flex items-center gap-2 rounded px-1 py-1 text-sm hover:bg-slate-50">
                      <input
                        type="checkbox"
                        className="h-4 w-4 accent-marca"
                        checked={form.countries.includes(p)}
                        onChange={() => alternarPais(p)}
                      />
                      {p}
                    </label>
                  ))}
                  {paisesVisiveis.length === 0 && <p className="text-sm text-slate-500">Nenhum país com esse nome no seu plano.</p>}
                </div>
              </div>
            ) : (
              <input
                id="countries_texto"
                placeholder="Ex.: Portugal, Espanha"
                className={classeCampo('countries')}
                value={form.countries_texto}
                onChange={(e) => alterar('countries_texto', e.target.value)}
              />
            )}
            <Erro campo="countries" />
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
              <span>Autorizo a SimPremium a usar estes dados para ativar e dar suporte à linha, conforme a LGPD.</span>
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
          <h1 className="text-xl font-semibold">{resultado.atualizado ? 'Cadastro atualizado!' : 'Cadastro recebido!'}</h1>
          {resultado.vigenciaFim && (
            <p className="text-sm text-slate-700">
              Ativação em <strong>{formatarDataBR(form.travel_start)}</strong>, válido até{' '}
              <strong>{formatarDataBR(resultado.vigenciaFim)}</strong>.
            </p>
          )}
          <p className="text-sm text-slate-600">
            {resultado.vinculadoAoPedido
              ? 'Localizamos o seu pedido. Nossa equipe confere e segue com a ativação.'
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

function CartaoPlano({ plano }: { plano: PlanoComprado }) {
  const itens = [
    plano.destino && { rotulo: 'Destino', valor: plano.destino },
    plano.dias && { rotulo: 'Período', valor: `${plano.dias} dias` },
    plano.franquia && { rotulo: 'Internet', valor: plano.franquia },
  ].filter(Boolean) as { rotulo: string; valor: string }[];
  return (
    <div className="rounded-lg border border-slate-200 px-4 py-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Seu plano</p>
      <p className="mt-0.5 font-medium">{plano.titulo}</p>
      {itens.length > 0 && (
        <dl className="mt-2 grid grid-cols-3 gap-2 text-sm">
          {itens.map((i) => (
            <div key={i.rotulo}>
              <dt className="text-xs text-slate-500">{i.rotulo}</dt>
              <dd className="font-semibold text-slate-900">{i.valor}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

function Passos({ etapa }: { etapa: Etapa }) {
  const itens: { chave: Etapa; texto: string }[] = [
    { chave: 'chip', texto: 'Compra' },
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
