'use client';

import { useMemo, useState } from 'react';
import {
  cadastroSchema, pedidosSchema, type Consulta, type PedidoPendente, type ResumoCadastro, type TipoChip,
} from '@/lib/cadastro-schema';
import { chaveIccid, formatarCpf, soDigitos } from '@/lib/documentos';
import { chaveTexto, fimDaVigencia, formatarDataBR, paisesDaLista } from '@/lib/plano';

type Etapa = 'cpf' | 'pedidos' | 'formulario' | 'concluido' | 'bloqueado';

interface Formulario {
  full_name: string;
  birth_date: string;
  email: string;
  phone: string;
  /** Chip físico sem ICCID lançado no pedido: o cliente digita. */
  iccid: string;
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
  iccid: '',
  travel_start: '',
  countries: [],
  countries_texto: '',
  observation: '',
  lgpd: false,
  website: '',
};

const TIPO_TEXTO: Record<TipoChip, string> = { fisico: 'Chip físico', virtual: 'eSIM' };

const hojeIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

function lerCampos(issues: { path: (string | number)[]; message: string }[]) {
  const campos: Record<string, string> = {};
  for (const issue of issues) campos[String(issue.path[0] ?? '_')] ??= issue.message;
  return campos;
}

/** Link do WhatsApp do suporte com a mensagem já escrita. Sem número configurado, `null`. */
function linkSuporte(numero: string, texto: string): string | null {
  const n = soDigitos(numero);
  return n ? `https://wa.me/${n}?text=${encodeURIComponent(texto)}` : null;
}

export function CadastroChip({ whatsappSuporte }: { whatsappSuporte: string }) {
  const [etapa, setEtapa] = useState<Etapa>('cpf');
  const [cpf, setCpf] = useState('');
  const [pedidos, setPedidos] = useState<PedidoPendente[]>([]);
  const [escolhido, setEscolhido] = useState<PedidoPendente | null>(null);
  const [consulta, setConsulta] = useState<Consulta | null>(null);
  const [form, setForm] = useState<Formulario>(VAZIO);
  const [filtroPais, setFiltroPais] = useState('');
  const [erros, setErros] = useState<Record<string, string>>({});
  const [erroGeral, setErroGeral] = useState<string | null>(null);
  const [carregando, setCarregando] = useState<string | null>(null);
  const [resultado, setResultado] = useState<{ vinculadoAoPedido: boolean; vigenciaFim: string | null } | null>(null);

  const tipo: TipoChip = consulta?.tipo ?? escolhido?.tipo ?? 'fisico';
  const suporte = linkSuporte(
    whatsappSuporte,
    escolhido
      ? `Olá! Já fiz o cadastro do pedido final ${escolhido.pedidoFinal} no GoChip e preciso alterar um dado.`
      : 'Olá! Não encontrei o meu pedido para ativar no GoChip.',
  );

  const plano = consulta?.plano ?? null;
  const cobertura = plano?.paises ?? [];
  /** Chip físico cujo ICCID a equipe ainda não lançou no pedido. */
  const pedeIccid = tipo === 'fisico' && !!consulta && !consulta.iccid;

  const alterar = <K extends keyof Formulario>(campo: K, valor: Formulario[K]) => {
    setForm((f) => ({ ...f, [campo]: valor }));
    const chave = campo === 'countries_texto' ? 'countries' : campo;
    setErros(({ [chave]: _, ...resto }) => resto);
  };

  function alternarPais(pais: string) {
    alterar('countries', form.countries.includes(pais) ? form.countries.filter((p) => p !== pais) : [...form.countries, pais]);
  }

  async function postar(url: string, corpo: unknown) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(corpo),
    });
    return { res, dados: await res.json() };
  }

  async function listarPedidos(e: React.FormEvent) {
    e.preventDefault();
    setErroGeral(null);
    const local = pedidosSchema.safeParse({ cpf });
    if (!local.success) {
      setErros(lerCampos(local.error.issues));
      return;
    }
    setCarregando('cpf');
    try {
      const { res, dados } = await postar('/api/pedidos', { cpf });
      if (!res.ok) {
        if (dados.campos) setErros(dados.campos);
        throw new Error(dados.error || 'Falha na consulta');
      }
      setPedidos(dados.pedidos as PedidoPendente[]);
      setErros({});
      setEtapa('pedidos');
    } catch (err) {
      setErroGeral((err as Error).message);
    } finally {
      setCarregando(null);
    }
  }

  async function escolherPedido(p: PedidoPendente) {
    setErroGeral(null);
    setEscolhido(p);
    setCarregando(`${p.pedido_id}:${p.item_id ?? ''}`);
    try {
      const { res, dados } = await postar('/api/consulta', { cpf, pedido_id: p.pedido_id, item_id: p.item_id });
      if (!res.ok) throw new Error(dados.error || 'Falha na consulta');
      const c = dados as Consulta;
      setConsulta(c);
      if (c.bloqueado) {
        setEtapa('bloqueado');
        return;
      }
      const pre = c.preenchimento;
      setForm({
        ...VAZIO,
        ...(pre ? { full_name: pre.full_name, email: pre.email, phone: pre.phone, birth_date: pre.birth_date, travel_start: pre.travel_start } : {}),
        countries: pre?.countries.length ? pre.countries : c.plano?.paises.length === 1 ? c.plano.paises : [],
      });
      setFiltroPais('');
      setErros({});
      setEtapa('formulario');
    } catch (err) {
      setErroGeral((err as Error).message);
    } finally {
      setCarregando(null);
    }
  }

  async function enviar(e: React.FormEvent) {
    e.preventDefault();
    setErroGeral(null);
    const { countries_texto, countries, iccid, ...resto } = form;
    const corpo = {
      ...resto,
      pedido_id: escolhido?.pedido_id,
      item_id: escolhido?.item_id ?? null,
      iccid: pedeIccid ? chaveIccid(iccid) : undefined,
      cpf,
      countries: cobertura.length ? countries : paisesDaLista(countries_texto),
    };
    if (pedeIccid && !iccid.trim()) {
      setErros({ iccid: 'Informe o número do chip (ICCID)' });
      setErroGeral('Confira os campos destacados.');
      return;
    }

    const local = cadastroSchema.safeParse(corpo);
    if (!local.success) {
      setErros(lerCampos(local.error.issues));
      setErroGeral('Confira os campos destacados.');
      return;
    }

    setCarregando('enviar');
    try {
      const { res, dados } = await postar('/api/cadastro', corpo);
      if (res.status === 409) {
        setEtapa('bloqueado');
        return;
      }
      if (!res.ok) {
        if (dados.campos) setErros(dados.campos);
        throw new Error(dados.error || 'Falha ao enviar');
      }
      setResultado({ vinculadoAoPedido: dados.vinculadoAoPedido, vigenciaFim: dados.vigenciaFim });
      setEtapa('concluido');
    } catch (err) {
      setErroGeral((err as Error).message);
    } finally {
      setCarregando(null);
    }
  }

  /** Volta para a lista de pedidos do mesmo CPF, já atualizada. */
  async function voltarParaPedidos() {
    setConsulta(null);
    setEscolhido(null);
    setForm(VAZIO);
    setErros({});
    setErroGeral(null);
    setResultado(null);
    setCarregando('cpf');
    try {
      const { res, dados } = await postar('/api/pedidos', { cpf });
      if (res.ok) setPedidos(dados.pedidos as PedidoPendente[]);
    } catch {
      // Sem rede: mostra a lista que já estava na tela.
    } finally {
      setCarregando(null);
    }
    setEtapa('pedidos');
  }

  function recomecar() {
    setEtapa('cpf');
    setCpf('');
    setPedidos([]);
    setEscolhido(null);
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
    erros[campo] ? <p className="mt-1.5 text-xs text-red-600">{erros[campo]}</p> : null;

  return (
    <div className="cartao px-4 py-7 sm:px-10 sm:py-10">
      <Passos etapa={etapa} />

      {erroGeral && (
        <div
          role="alert"
          className="mx-auto mt-6 flex max-w-md items-start gap-2.5 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm font-light text-red-700"
        >
          <Icone nome="alerta" className="mt-0.5 h-4 w-4 shrink-0" />
          {erroGeral}
        </div>
      )}

      <div className="mt-8 sm:mt-10">
        {etapa === 'cpf' && (
          <form onSubmit={listarPedidos} noValidate className="painel mx-auto max-w-md space-y-7">
            <div>
              <h1 className="titulo">Ative seu chip</h1>
              <p className="subtitulo">Informe o CPF da sua conta no Mercado Livre para ver as compras a ativar.</p>
            </div>

            <div className="grupo">
              <label htmlFor="cpf" className="rotulo">CPF da conta no Mercado Livre</label>
              <input
                id="cpf"
                inputMode="numeric"
                autoComplete="off"
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

            <button type="submit" className="botao" disabled={!!carregando}>
              {carregando ? 'Consultando…' : <>Continuar <Icone nome="seta" className="h-4 w-4" /></>}
            </button>
          </form>
        )}

        {etapa === 'pedidos' && (
          <div className="mx-auto max-w-md space-y-6">
            <div className="text-center">
              <h1 className="titulo">Escolha o pedido</h1>
              <p className="subtitulo">
                Compras do CPF <span className="font-normal text-slate-600">{cpf}</span> ainda sem data de ativação
              </p>
            </div>

            {pedidos.length > 0 ? (
              <ul className="resumo space-y-3 !p-3 sm:!p-4">
                {pedidos.map((p) => {
                  const chave = `${p.pedido_id}:${p.item_id ?? ''}`;
                  const detalhes = [p.destino, p.dias && `${p.dias} dias`, p.franquia].filter(Boolean).join(' · ');
                  return (
                    <li key={chave}>
                      <button
                        type="button"
                        onClick={() => escolherPedido(p)}
                        disabled={!!carregando}
                        className="flex w-full items-center gap-4 rounded-xl bg-white p-4 text-left ring-1 ring-transparent transition hover:ring-marca disabled:opacity-60"
                      >
                        <Capa tipo={p.tipo} pequena />
                        <span className="min-w-0 flex-1">
                          <span className="block text-[15px] text-slate-900">
                            {TIPO_TEXTO[p.tipo]} <span className="text-xs font-light text-slate-400">· final {p.pedidoFinal}</span>
                          </span>
                          <span className="mt-0.5 block truncate text-sm font-light text-slate-500">{detalhes || p.titulo}</span>
                          <span className="mt-1 block text-xs font-light text-slate-400">
                            {p.compradoEm && <>Compra em {formatarDataBR(p.compradoEm)}</>}
                            {p.envioIncompleto && <span className="text-amber-600"> · envio não concluído</span>}
                          </span>
                        </span>
                        {carregando === chave ? (
                          <span className="text-xs font-light text-slate-400">Abrindo…</span>
                        ) : (
                          <Icone nome="seta" className="h-4 w-4 shrink-0 text-marca" />
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <div className="resumo space-y-4 text-center text-sm font-light leading-relaxed text-slate-600">
                <p>
                  Não encontramos compras pendentes de ativação neste CPF. Confira se é o CPF da conta do Mercado Livre
                  que fez a compra ou fale com o suporte.
                </p>
                <BotaoSuporte link={suporte} texto="Falar com o suporte no WhatsApp" />
              </div>
            )}

            <button type="button" onClick={recomecar} className="botao-secundario w-full" disabled={!!carregando}>
              Usar outro CPF
            </button>
          </div>
        )}

        {etapa === 'formulario' && consulta && (
          <form onSubmit={enviar} noValidate className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_360px] lg:gap-10">
            <div className="painel space-y-10">
              <section className="space-y-7">
                <div>
                  <h2 className="titulo">Dados do titular</h2>
                  <p className="subtitulo">
                    {consulta.preenchimento?.full_name
                      ? 'Preenchemos com os dados da compra. Confira e corrija se preciso.'
                      : 'Preencha com os dados de quem vai usar o chip.'}
                  </p>
                </div>

                {pedeIccid && (
                  <div className="grupo">
                    <label htmlFor="iccid" className="rotulo">Número do chip (ICCID)</label>
                    <input
                      id="iccid"
                      inputMode="numeric"
                      autoComplete="off"
                      placeholder="8955 0000 0000 0000 000"
                      className={`${classeCampo('iccid')} font-mono tracking-wider`}
                      value={form.iccid}
                      onChange={(e) => alterar('iccid', e.target.value)}
                    />
                    <p className="ajuda">Impresso no cartão do chip, abaixo do código de barras.</p>
                    <Erro campo="iccid" />
                  </div>
                )}

                <div className="grupo">
                  <label htmlFor="full_name" className="rotulo">Nome completo</label>
                  <input
                    id="full_name"
                    autoComplete="name"
                    className={classeCampo('full_name')}
                    value={form.full_name}
                    onChange={(e) => alterar('full_name', e.target.value)}
                  />
                  <Erro campo="full_name" />
                </div>

                <div className="grid gap-7 sm:grid-cols-2 sm:gap-5">
                  <div className="grupo">
                    <span className="rotulo">CPF</span>
                    <p className="campo flex items-center text-slate-500">{cpf}</p>
                    <Erro campo="cpf" />
                  </div>
                  <div className="grupo">
                    <label htmlFor="birth_date" className="rotulo">Nascimento (opcional)</label>
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

                <div className="grupo">
                  <label htmlFor="email" className="rotulo">E-mail</label>
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

                <div className="grupo">
                  <label htmlFor="phone" className="rotulo">Telefone / WhatsApp</label>
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
              </section>

              <section className="space-y-7">
                <div>
                  <h2 className="titulo">Ativação</h2>
                  <p className="subtitulo">Quando o chip deve começar a funcionar e para onde você vai.</p>
                </div>

                <div className="grupo">
                  <label htmlFor="travel_start" className="rotulo">Data de ativação</label>
                  <input
                    id="travel_start"
                    type="date"
                    min={hojeIso()}
                    className={classeCampo('travel_start')}
                    value={form.travel_start}
                    onChange={(e) => alterar('travel_start', e.target.value)}
                  />
                  <Erro campo="travel_start" />
                </div>

                <div className="grupo">
                  <span className="rotulo">Países que vai visitar</span>
                  {cobertura.length >= 1 ? (
                    <div className={`rounded-lg border px-4 pb-4 pt-5 ${erros.countries ? 'border-red-400' : 'border-slate-400/70'}`}>
                      {cobertura.length === 1 ? (
                        <div className="flex items-center gap-2 text-sm font-light text-slate-500">
                          <span className="inline-flex items-center gap-1.5 rounded-full bg-marca px-3 py-1.5 text-sm text-white">
                            <Icone nome="check" className="h-3.5 w-3.5" /> {cobertura[0]}
                          </span>
                          incluído no seu plano
                        </div>
                      ) : (
                        <>
                          <div className="mb-3 flex items-center justify-between gap-2 text-xs font-light text-slate-400">
                            <span>Seu plano cobre {cobertura.length} países. Toque para marcar.</span>
                            {form.countries.length > 0 && (
                              <span className="shrink-0 rounded-full bg-marca-claro px-2 py-0.5 text-marca">
                                {form.countries.length} selecionado{form.countries.length > 1 ? 's' : ''}
                              </span>
                            )}
                          </div>
                          {cobertura.length > 8 && (
                            <div className="relative mb-3">
                              <Icone nome="busca" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                              <input
                                type="search"
                                placeholder="Buscar país"
                                className="campo h-10 pl-9 text-sm"
                                value={filtroPais}
                                onChange={(e) => setFiltroPais(e.target.value)}
                              />
                            </div>
                          )}
                          <div className="flex max-h-60 flex-wrap gap-2 overflow-y-auto">
                            {paisesVisiveis.map((p) => {
                              const marcado = form.countries.includes(p);
                              return (
                                <button
                                  key={p}
                                  type="button"
                                  aria-pressed={marcado}
                                  onClick={() => alternarPais(p)}
                                  className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm transition ${
                                    marcado
                                      ? 'border-marca bg-marca text-white'
                                      : 'border-slate-300 bg-white font-light text-slate-700 hover:border-marca hover:text-marca'
                                  }`}
                                >
                                  {marcado && <Icone nome="check" className="h-3.5 w-3.5" />}
                                  {p}
                                </button>
                              );
                            })}
                            {paisesVisiveis.length === 0 && (
                              <p className="text-sm font-light text-slate-400">Nenhum país com esse nome no seu plano.</p>
                            )}
                          </div>
                        </>
                      )}
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

                <div className="grupo">
                  <label htmlFor="observation" className="rotulo">Observações (opcional)</label>
                  <textarea
                    id="observation"
                    rows={3}
                    className={classeCampo('observation')}
                    value={form.observation}
                    onChange={(e) => alterar('observation', e.target.value)}
                  />
                  <Erro campo="observation" />
                </div>
              </section>

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
            </div>

            <aside className="resumo lg:sticky lg:top-6">
              <h2 className="text-xl font-light text-slate-900">Seu plano</h2>

              <div className="mt-6 flex gap-4">
                <Capa tipo={tipo} />
                <div className="min-w-0">
                  <p className="text-[15px] leading-snug text-slate-900">{plano?.destino || TIPO_TEXTO[tipo]}</p>
                  <p className="mt-1 text-xs font-light leading-snug text-slate-500">{plano?.titulo || escolhido?.titulo}</p>
                  <p className="mt-2 text-xs font-light text-slate-400">
                    {TIPO_TEXTO[tipo]}
                    {consulta.pedidoFinal && <> · pedido final {consulta.pedidoFinal}</>}
                  </p>
                  {consulta.iccid && <p className="mt-0.5 font-mono text-[11px] text-slate-400">{consulta.iccid}</p>}
                </div>
              </div>

              <dl className="mt-6 space-y-3 text-sm">
                <Linha rotulo="Período" valor={plano?.dias ? `${plano.dias} dias` : '—'} />
                <Linha rotulo="Internet" valor={plano?.franquia || '—'} />
                <Linha rotulo="Ativação" valor={form.travel_start ? formatarDataBR(form.travel_start) : '—'} />
              </dl>
              <div className="mt-5 border-t border-slate-300/70 pt-5">
                <Linha rotulo="Válido até" valor={vigenciaFim ? formatarDataBR(vigenciaFim) : '—'} forte />
              </div>

              {consulta.jaCadastrado && (
                <p className="mt-5 rounded-lg bg-amber-50 px-3 py-2.5 text-xs font-light leading-relaxed text-amber-800">
                  O envio anterior deste pedido não foi concluído. Confira os dados e envie para concluir.
                </p>
              )}

              <label className="mt-6 flex items-start gap-2.5 text-xs font-light leading-relaxed text-slate-500">
                <input
                  type="checkbox"
                  className="caixa mt-px"
                  checked={form.lgpd}
                  onChange={(e) => alterar('lgpd', e.target.checked)}
                />
                <span>
                  Autorizo o uso destes dados para ativar e dar suporte à linha, conforme a <span className="text-marca">LGPD</span>.
                </span>
              </label>
              <Erro campo="lgpd" />

              <button type="submit" className="botao mt-6" disabled={!!carregando}>
                {carregando ? 'Enviando…' : 'Enviar cadastro'}
              </button>
              <button type="button" onClick={voltarParaPedidos} className="link mt-4 block w-full text-center text-sm">
                Trocar pedido
              </button>
            </aside>
          </form>
        )}

        {etapa === 'concluido' && resultado && (
          <div className="painel mx-auto max-w-md space-y-6 text-center">
            <Selo nome="check" />
            <div>
              <h1 className="titulo">Cadastro recebido</h1>
              <p className="subtitulo leading-relaxed">
                {resultado.vinculadoAoPedido
                  ? 'Localizamos o seu pedido. Nossa equipe confere e segue com a ativação.'
                  : 'Nossa equipe vai localizar o seu pedido e seguir com a ativação.'}
              </p>
            </div>
            {resultado.vigenciaFim && (
              <div className="resumo !p-4 text-sm font-light text-slate-600">
                Ativação em <span className="font-normal text-slate-900">{formatarDataBR(form.travel_start)}</span> · válido até{' '}
                <span className="font-normal text-slate-900">{formatarDataBR(resultado.vigenciaFim)}</span>
              </div>
            )}
            <div className="space-y-3">
              <p className="text-xs font-light text-slate-400">Os dados enviados não podem mais ser alterados por aqui.</p>
              <BotaoSuporte link={suporte} texto="Precisa corrigir algo? Fale com o suporte" />
              <button type="button" onClick={voltarParaPedidos} className="botao-secundario w-full">
                Ativar outro pedido
              </button>
            </div>
          </div>
        )}

        {etapa === 'bloqueado' && (
          <div className="painel mx-auto max-w-md space-y-6 text-center">
            <Selo nome="cadeado" />
            <div>
              <h1 className="titulo">Cadastro já realizado</h1>
              <p className="subtitulo leading-relaxed">
                Já recebemos os dados deste pedido. Por segurança, eles não podem ser alterados por aqui. Para corrigir
                alguma informação, fale com o nosso suporte.
              </p>
            </div>
            {consulta?.resumo && <ResumoDoCadastro resumo={consulta.resumo} />}
            <div className="space-y-3">
              <BotaoSuporte link={suporte} texto="Falar com o suporte no WhatsApp" destaque />
              <button type="button" onClick={voltarParaPedidos} className="botao-secundario w-full">
                Ativar outro pedido
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Linha({ rotulo, valor, forte = false }: { rotulo: string; valor: string; forte?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4 text-sm">
      <dt className={forte ? 'font-medium text-slate-900' : 'font-light text-slate-600'}>{rotulo}</dt>
      <dd className={forte ? 'font-medium text-slate-900' : 'text-slate-900'}>{valor}</dd>
    </div>
  );
}

/** "Capa" do produto, como a do livro no checkout: um bloco azul com o ícone do chip. */
function Capa({ tipo, pequena = false }: { tipo: TipoChip; pequena?: boolean }) {
  return (
    <span
      className={`flex shrink-0 items-center justify-center rounded-md bg-gradient-to-br from-marca to-marca-profundo text-white ${
        pequena ? 'h-12 w-10' : 'h-20 w-16'
      }`}
    >
      <Icone nome={tipo === 'fisico' ? 'chip' : 'esim'} className={pequena ? 'h-5 w-5' : 'h-7 w-7'} />
    </span>
  );
}

function Selo({ nome }: { nome: NomeIcone }) {
  return (
    <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-marca-claro">
      <Icone nome={nome} className="h-7 w-7 text-marca" />
    </div>
  );
}

function ResumoDoCadastro({ resumo }: { resumo: ResumoCadastro }) {
  const linhas = [
    { rotulo: 'Plano', valor: resumo.plano },
    { rotulo: 'Destino', valor: resumo.destino },
    { rotulo: 'Internet', valor: resumo.franquia },
    { rotulo: 'Período', valor: resumo.dias ? `${resumo.dias} dias` : null },
    { rotulo: 'Ativação', valor: resumo.ativacao ? formatarDataBR(resumo.ativacao) : null },
    { rotulo: 'Válido até', valor: resumo.fim ? formatarDataBR(resumo.fim) : null },
    { rotulo: 'Países', valor: resumo.paises.length ? resumo.paises.join(', ') : null },
  ].filter((l): l is { rotulo: string; valor: string } => !!l.valor);
  if (linhas.length === 0) return null;
  return (
    <div className="resumo !p-5 text-left">
      <p className="mb-4 text-base font-light text-slate-900">Resumo do cadastro</p>
      <dl className="space-y-2.5">
        {linhas.map((l) => (
          <div key={l.rotulo} className="flex gap-4 text-sm">
            <dt className="w-24 shrink-0 font-light text-slate-500">{l.rotulo}</dt>
            <dd className="text-slate-900">{l.valor}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function BotaoSuporte({ link, texto, destaque = false }: { link: string | null; texto: string; destaque?: boolean }) {
  if (!link) {
    return <p className="text-sm font-light text-slate-500">Fale com o nosso suporte pelo WhatsApp.</p>;
  }
  return (
    <a
      href={link}
      target="_blank"
      rel="noopener noreferrer"
      className={
        destaque
          ? 'inline-flex h-12 w-full items-center justify-center gap-2 rounded-lg bg-[#25D366] px-4 text-[15px] text-white transition hover:bg-[#1ebe5a]'
          : 'inline-flex h-12 w-full items-center justify-center gap-2 rounded-lg border border-[#25D366]/50 bg-white px-4 text-[15px] font-light text-[#128C7E] transition hover:bg-[#25D366]/5'
      }
    >
      <IconeWhatsApp className="h-5 w-5" />
      {texto}
    </a>
  );
}

function IconeWhatsApp({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.75.46 3.45 1.32 4.95L2.05 22l5.25-1.38a9.9 9.9 0 0 0 4.74 1.21h.01c5.46 0 9.91-4.45 9.91-9.91 0-2.65-1.03-5.14-2.9-7.01A9.82 9.82 0 0 0 12.04 2Zm0 18.15h-.01a8.23 8.23 0 0 1-4.19-1.15l-.3-.18-3.12.82.83-3.04-.2-.31a8.2 8.2 0 0 1-1.26-4.38c0-4.54 3.7-8.24 8.25-8.24 2.2 0 4.27.86 5.83 2.42a8.18 8.18 0 0 1 2.41 5.83c0 4.54-3.7 8.23-8.24 8.23Zm4.52-6.16c-.25-.12-1.47-.72-1.7-.8-.23-.09-.39-.13-.56.12-.16.25-.64.8-.78.97-.14.16-.29.19-.54.06-.25-.12-1.05-.39-1.99-1.23-.74-.66-1.23-1.47-1.38-1.72-.14-.25-.02-.38.11-.51.11-.11.25-.29.37-.43.13-.15.17-.25.25-.42.08-.16.04-.31-.02-.43-.06-.13-.56-1.35-.76-1.84-.2-.48-.41-.42-.56-.43h-.48a.92.92 0 0 0-.66.31c-.23.25-.87.85-.87 2.07 0 1.22.89 2.4 1.01 2.56.12.17 1.75 2.67 4.24 3.74.59.26 1.05.41 1.41.52.59.19 1.13.16 1.56.1.48-.07 1.47-.6 1.67-1.18.21-.58.21-1.07.15-1.18-.06-.1-.22-.16-.47-.28Z" />
    </svg>
  );
}

function Passos({ etapa }: { etapa: Etapa }) {
  const itens: { chave: Etapa; texto: string }[] = [
    { chave: 'cpf', texto: 'Cadastro' },
    { chave: 'pedidos', texto: 'Pedido' },
    { chave: 'formulario', texto: 'Dados' },
    { chave: 'concluido', texto: 'Pronto' },
  ];
  const atual = etapa === 'bloqueado' ? itens.length - 1 : itens.findIndex((i) => i.chave === etapa);
  return (
    <ol className="flex flex-wrap items-center justify-center gap-x-2.5 gap-y-1 text-sm font-light sm:gap-x-4 sm:text-[17px]">
      {itens.map((item, i) => (
        <li key={item.chave} className="flex items-center gap-2.5 sm:gap-4">
          <span
            aria-current={i === atual ? 'step' : undefined}
            className={i === atual ? 'font-normal text-slate-900' : i < atual ? 'text-slate-500' : 'text-slate-300'}
          >
            {item.texto}
          </span>
          {i < itens.length - 1 && (
            <svg viewBox="0 0 28 10" className="h-2.5 w-6 text-slate-400" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true">
              <path d="M1 5h25M22 1.5 26 5l-4 3.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
        </li>
      ))}
    </ol>
  );
}

type NomeIcone = 'chip' | 'esim' | 'seta' | 'check' | 'calendario' | 'busca' | 'alerta' | 'cadeado';

function Icone({ nome, className }: { nome: NomeIcone; className?: string }) {
  const tracos: Record<NomeIcone, React.ReactNode> = {
    chip: (
      <>
        <path d="M8 3h6.5L19 7.5V19a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z" />
        <rect x="9" y="11" width="7" height="6" rx="1" />
      </>
    ),
    esim: (
      <>
        <rect x="3" y="3" width="7" height="7" rx="1.5" />
        <rect x="14" y="3" width="7" height="7" rx="1.5" />
        <rect x="3" y="14" width="7" height="7" rx="1.5" />
        <path d="M14 14h3v3M21 14v.01M14 21h7v-4" />
      </>
    ),
    seta: <path d="M5 12h14M13 6l6 6-6 6" />,
    cadeado: (
      <>
        <rect x="4.5" y="10.5" width="15" height="10" rx="2.5" />
        <path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" />
      </>
    ),
    check: <path d="m5 12.5 4.5 4.5L19 7.5" />,
    calendario: (
      <>
        <rect x="3.5" y="5" width="17" height="15.5" rx="2.5" />
        <path d="M3.5 10h17M8 3v4M16 3v4" />
      </>
    ),
    busca: (
      <>
        <circle cx="11" cy="11" r="6.5" />
        <path d="m20 20-4-4" />
      </>
    ),
    alerta: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7.5v5M12 16v.01" />
      </>
    ),
  };
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      {tracos[nome]}
    </svg>
  );
}
