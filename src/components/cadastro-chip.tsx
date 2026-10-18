'use client';

import { useMemo, useState } from 'react';
import {
  cadastroSchema, chaveDoCampo, pedidosSchema,
  type ChipConsulta, type Consulta, type ListaPedidos, type PedidoPendente, type ResumoCadastro, type TipoChip,
} from '@/lib/cadastro-schema';
import { chaveIccid, formatarCpf, soDigitos } from '@/lib/documentos';
import { chaveTexto, fimDaVigencia, formatarDataBR, paisesDaLista } from '@/lib/plano';

type Etapa = 'cpf' | 'pedidos' | 'formulario' | 'concluido' | 'bloqueado';

/** Data de ativação e países de um chip (ou de todos, com "mesmos dados"). */
interface Ativacao {
  travel_start: string;
  countries: string[];
  /** Países digitados à mão, quando a cobertura do plano não é conhecida. */
  countries_texto: string;
}

interface Formulario {
  full_name: string;
  birth_date: string;
  email: string;
  phone: string;
  observation: string;
  lgpd: boolean;
  website: string;
  /** Mesma data de ativação e mesmos países para todos os chips do pedido. */
  mesmos: boolean;
  comum: Ativacao;
  /** Uma por chip, na ordem de `consulta.chips`. */
  chips: Ativacao[];
  /** ICCID digitado de cada chip físico que a equipe ainda não lançou no pedido. */
  iccids: string[];
}

const ATIVACAO_VAZIA: Ativacao = { travel_start: '', countries: [], countries_texto: '' };

const VAZIO: Formulario = {
  full_name: '',
  birth_date: '',
  email: '',
  phone: '',
  observation: '',
  lgpd: false,
  website: '',
  mesmos: true,
  comum: ATIVACAO_VAZIA,
  chips: [],
  iccids: [],
};

const LISTA_VAZIA: ListaPedidos = { cpfEncontrado: false, pedidos: [], recentes: [] };

const TIPO_TEXTO: Record<TipoChip, string> = { fisico: 'Chip físico', virtual: 'eSIM' };

const CAMPOS_DE_ATIVACAO = ['travel_start', 'countries'];

const hojeIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

function lerCampos(issues: { path: (string | number)[]; message: string }[]) {
  const campos: Record<string, string> = {};
  for (const issue of issues) campos[chaveDoCampo(issue.path)] ??= issue.message;
  return campos;
}

/** Link do WhatsApp do suporte com a mensagem já escrita. Sem número configurado, `null`. */
function linkSuporte(numero: string, texto: string): string | null {
  const n = soDigitos(numero);
  return n ? `https://wa.me/${n}?text=${encodeURIComponent(texto)}` : null;
}

/**
 * Países que todos os chips cobrem, para a escolha única com "mesmos dados". Plano de
 * cobertura desconhecida não restringe; se nenhum plano tem cobertura, o cliente digita.
 */
function coberturaComum(chips: ChipConsulta[]): string[] {
  const conhecidas = chips.map((c) => c.plano?.paises ?? []).filter((l) => l.length > 0);
  if (conhecidas.length === 0) return [];
  return conhecidas.reduce((acc, lista) => {
    const chaves = new Set(lista.map(chaveTexto));
    return acc.filter((p) => chaves.has(chaveTexto(p)));
  });
}

/**
 * Os países escolhidos que cabem numa cobertura (vazia = qualquer um). Cobertura de um
 * país só já vem escolhida: a tela mostra esse país como incluído, sem botão para marcar.
 */
const naCobertura = (paises: string[], cobertura: string[]) => {
  if (cobertura.length === 0) return paises;
  if (cobertura.length === 1) return cobertura;
  const chaves = new Set(paises.map(chaveTexto));
  return cobertura.filter((p) => chaves.has(chaveTexto(p)));
};

const nomeDoChip = (chip: ChipConsulta, i: number, total: number) =>
  total > 1 ? `Chip ${i + 1} · ${TIPO_TEXTO[chip.tipo]}` : TIPO_TEXTO[chip.tipo];

const textoDosChips = (n: number, tipos: TipoChip[]) =>
  `${n > 1 ? `${n} chips` : TIPO_TEXTO[tipos[0] ?? 'fisico']}${n > 1 ? ` · ${tipos.map((t) => TIPO_TEXTO[t]).join(' e ')}` : ''}`;

export function CadastroChip({ whatsappSuporte }: { whatsappSuporte: string }) {
  const [etapa, setEtapa] = useState<Etapa>('cpf');
  const [cpf, setCpf] = useState('');
  const [lista, setLista] = useState<ListaPedidos>(LISTA_VAZIA);
  const pedidos = lista.pedidos;
  const [escolhido, setEscolhido] = useState<PedidoPendente | null>(null);
  const [consulta, setConsulta] = useState<Consulta | null>(null);
  const [form, setForm] = useState<Formulario>(VAZIO);
  const [erros, setErros] = useState<Record<string, string>>({});
  const [erroGeral, setErroGeral] = useState<string | null>(null);
  const [carregando, setCarregando] = useState<string | null>(null);
  const [resultado, setResultado] = useState<{ chips: { tipo: TipoChip; travel_start: string; vigenciaFim: string | null }[] } | null>(null);

  const suporte = linkSuporte(
    whatsappSuporte,
    escolhido
      ? `Olá! Já fiz o cadastro do pedido final ${escolhido.pedidoFinal} no GoChip e preciso alterar um dado.`
      : lista.recentes.length
        ? 'Olá! Já enviei os dados de ativação no GoChip e preciso alterar um dado.'
        : 'Olá! Não encontrei o meu pedido para ativar no GoChip.',
  );

  const chips = consulta?.chips ?? [];
  const varios = chips.length > 1;
  const comum = useMemo(() => coberturaComum(chips), [chips]);
  /** Os chips usam a ativação comum: um chip só, ou vários com "mesmos dados" marcado. */
  const usaComum = !varios || form.mesmos;

  const alterar = <K extends keyof Formulario>(campo: K, valor: Formulario[K]) => {
    setForm((f) => ({ ...f, [campo]: valor }));
    setErros(({ [campo]: _, ...resto }) => resto);
  };

  /** Apaga os erros de um campo de ativação: de todos os chips (comum) ou de um. */
  function limparErros(campo: string, chip?: number) {
    setErros((atual) =>
      Object.fromEntries(
        Object.entries(atual).filter(([k]) => {
          const m = k.match(/^chips\.(\d+)\.(.+)$/);
          return !m || m[2] !== campo || (chip !== undefined && Number(m[1]) !== chip);
        }),
      ),
    );
  }

  function alterarComum(parte: Partial<Ativacao>) {
    setForm((f) => ({ ...f, comum: { ...f.comum, ...parte } }));
    for (const campo of Object.keys(parte)) limparErros(campo === 'countries_texto' ? 'countries' : campo);
  }

  function alterarChip(i: number, parte: Partial<Ativacao>) {
    setForm((f) => ({ ...f, chips: f.chips.map((a, j) => (j === i ? { ...a, ...parte } : a)) }));
    for (const campo of Object.keys(parte)) limparErros(campo === 'countries_texto' ? 'countries' : campo, i);
  }

  function alterarIccid(i: number, valor: string) {
    setForm((f) => ({ ...f, iccids: f.iccids.map((v, j) => (j === i ? valor : v)) }));
    limparErros('iccid', i);
  }

  /** Marca/desmarca "mesmos dados": os dados de um lado passam para o outro. */
  function alternarMesmos(mesmos: boolean) {
    setForm((f) =>
      mesmos
        ? { ...f, mesmos, comum: { ...f.chips[0], countries: naCobertura(f.chips[0]?.countries ?? [], comum) } }
        : {
            ...f,
            mesmos,
            chips: chips.map((c) => ({ ...f.comum, countries: naCobertura(f.comum.countries, c.plano?.paises ?? []) })),
          },
    );
    setErros((atual) => Object.fromEntries(Object.entries(atual).filter(([k]) => !CAMPOS_DE_ATIVACAO.some((c) => k.endsWith(`.${c}`)))));
  }

  /** Erro de um campo de ativação: o do chip ou, na ativação comum, o primeiro de qualquer chip. */
  function erroAtivacao(campo: string, chip?: number): string | undefined {
    if (chip !== undefined) return erros[`chips.${chip}.${campo}`];
    return chips.map((_, i) => erros[`chips.${i}.${campo}`]).find(Boolean);
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
      setLista(dados as ListaPedidos);
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
    setCarregando(p.pedido_id);
    try {
      const { res, dados } = await postar('/api/consulta', { cpf, pedido_id: p.pedido_id });
      if (!res.ok) throw new Error(dados.error || 'Falha na consulta');
      const c = dados as Consulta;
      setConsulta(c);
      if (c.bloqueado) {
        setEtapa('bloqueado');
        return;
      }
      const pre = c.preenchimento;
      const porChip: Ativacao[] = c.chips.map((chip) => ({
        travel_start: chip.travel_start,
        countries: naCobertura(chip.countries, chip.plano?.paises ?? []),
        countries_texto: '',
      }));
      // Só abre com cada chip separado quando um envio anterior gravou datas ou países
      // diferentes entre os chips; senão "mesmos dados" vem marcado.
      const anteriores = porChip.filter((_, i) => c.chips[i].jaCadastrado);
      const iguais = anteriores.every(
        (a) => a.travel_start === anteriores[0].travel_start && a.countries.join('|') === anteriores[0].countries.join('|'),
      );
      const base = anteriores[0] ?? porChip[0];
      setForm({
        ...VAZIO,
        ...(pre ? { full_name: pre.full_name, email: pre.email, phone: pre.phone, birth_date: pre.birth_date } : {}),
        mesmos: iguais,
        comum: { ...base, countries: naCobertura(base?.countries ?? [], coberturaComum(c.chips)) },
        chips: porChip,
        iccids: c.chips.map(() => ''),
      });
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
    const { comum: ativacaoComum, chips: porChip, iccids, mesmos: _, ...resto } = form;
    const corpo = {
      ...resto,
      pedido_id: escolhido?.pedido_id,
      cpf,
      chips: chips.map((chip, i) => {
        const a = usaComum ? ativacaoComum : porChip[i];
        const cobertura = usaComum ? comum : chip.plano?.paises ?? [];
        return {
          item_id: chip.item_id,
          posicao: chip.posicao,
          iccid: chip.tipo === 'fisico' && !chip.iccid ? chaveIccid(iccids[i]) || undefined : undefined,
          travel_start: a.travel_start,
          countries: cobertura.length ? a.countries : paisesDaLista(a.countries_texto),
        };
      }),
    };

    const local = cadastroSchema.safeParse(corpo);
    const campos = local.success ? {} : lerCampos(local.error.issues);
    chips.forEach((chip, i) => {
      if (chip.tipo === 'fisico' && !chip.iccid && !iccids[i].trim()) campos[`chips.${i}.iccid`] = 'Informe o número do chip (ICCID)';
    });
    if (Object.keys(campos).length) {
      setErros(campos);
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
      setResultado({ chips: dados.chips });
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
      if (res.ok) setLista(dados as ListaPedidos);
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
    setLista(LISTA_VAZIA);
    setEscolhido(null);
    setConsulta(null);
    setForm(VAZIO);
    setErros({});
    setErroGeral(null);
    setResultado(null);
  }

  /** A ativação que vale para o chip `i` na tela. */
  const ativacaoDo = (i: number) => (usaComum ? form.comum : form.chips[i] ?? ATIVACAO_VAZIA);
  const pedemIccid = chips.map((c, i) => ({ chip: c, i })).filter(({ chip }) => chip.tipo === 'fisico' && !chip.iccid);

  const classeCampo = (campo: string) => `campo ${erros[campo] ? 'campo-erro' : ''}`;
  const Erro = ({ campo }: { campo: string }) => <ErroTexto texto={erros[campo]} />;

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
              <h1 className="titulo">
                {pedidos.length > 0 ? 'Escolha o pedido' : lista.recentes.length > 0 ? 'Seus pedidos' : 'CPF não encontrado'}
              </h1>
              <p className="subtitulo">
                {pedidos.length > 0 ? 'Compras do CPF ' : lista.recentes.length > 0 ? 'Últimas compras do CPF ' : 'Nenhuma compra com o CPF '}
                <span className="font-normal text-slate-600">{cpf}</span>
                {pedidos.length > 0 && ' ainda sem data de ativação'}
              </p>
            </div>

            {pedidos.length > 0 ? (
              <ul className="resumo space-y-3 !p-3 sm:!p-4">
                {pedidos.map((p) => {
                  const chave = p.pedido_id;
                  const detalhes = [p.destino, p.dias && `${p.dias} dias`, p.franquia].filter(Boolean).join(' · ');
                  return (
                    <li key={chave}>
                      <button
                        type="button"
                        onClick={() => escolherPedido(p)}
                        disabled={!!carregando}
                        className="flex w-full items-center gap-4 rounded-xl bg-white p-4 text-left ring-1 ring-transparent transition hover:ring-marca disabled:opacity-60"
                      >
                        <Capa tipo={p.tipos[0] ?? 'fisico'} pequena quantidade={p.chips} />
                        <span className="min-w-0 flex-1">
                          <span className="block text-[15px] text-slate-900">
                            {textoDosChips(p.chips, p.tipos)}{' '}
                            <span className="text-xs font-light text-slate-400">· final {p.pedidoFinal}</span>
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
            ) : lista.recentes.length > 0 ? (
              <>
                <div className="flex items-start gap-3 rounded-xl bg-marca-claro px-4 py-3.5 text-sm font-light leading-relaxed text-slate-700">
                  <Icone nome="check" className="mt-0.5 h-4 w-4 shrink-0 text-marca" />
                  <p>
                    Os dados de ativação {lista.recentes.length > 1 ? 'destes pedidos' : 'deste pedido'} já foram enviados.
                    Não há nenhuma compra deste CPF aguardando cadastro.
                  </p>
                </div>
                <ul className="space-y-3">
                  {lista.recentes.map((p) => {
                    const detalhes = [p.destino, p.dias && `${p.dias} dias`, p.franquia].filter(Boolean).join(' · ');
                    return (
                      <li key={p.pedido_id} className="flex items-center gap-4 rounded-xl border border-slate-200 bg-white p-4">
                        <Capa tipo={p.tipos[0] ?? 'fisico'} pequena quantidade={p.chips} />
                        <span className="min-w-0 flex-1">
                          <span className="block text-[15px] text-slate-900">
                            {textoDosChips(p.chips, p.tipos)}{' '}
                            <span className="text-xs font-light text-slate-400">· final {p.pedidoFinal}</span>
                          </span>
                          <span className="mt-0.5 block truncate text-sm font-light text-slate-500">{detalhes || p.titulo}</span>
                          <span className="mt-1 block text-xs font-light text-slate-400">
                            {p.compradoEm && <>Compra em {formatarDataBR(p.compradoEm)}</>}
                            {p.ativacao && <> · ativação em {formatarDataBR(p.ativacao)}</>}
                          </span>
                          <span className="mt-2 inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2.5 py-1 text-[11px] font-medium text-emerald-700">
                            <Icone nome="check" className="h-3 w-3" /> Dados enviados
                          </span>
                        </span>
                      </li>
                    );
                  })}
                </ul>
                <BotaoSuporte link={suporte} texto="Alterar algo? Fale com o suporte" />
              </>
            ) : (
              <div className="resumo space-y-4 text-center text-sm font-light leading-relaxed text-slate-600">
                <p>
                  Não encontramos compras do Mercado Livre neste CPF. Confira se é o CPF da conta que fez a compra ou fale
                  com o suporte.
                </p>
                <BotaoSuporte link={suporte} texto="Falar com o suporte" />
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
                    {varios && ' Valem para todos os chips do pedido.'}
                  </p>
                </div>

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

              {pedemIccid.length > 0 && (
                <section className="space-y-7">
                  <div>
                    <h2 className="titulo">{pedemIccid.length > 1 ? 'Números dos chips' : 'Número do chip'}</h2>
                    <p className="subtitulo">O ICCID vem impresso no cartão do chip, abaixo do código de barras.</p>
                  </div>
                  {pedemIccid.map(({ chip, i }) => (
                    <div key={i} className="grupo">
                      <label htmlFor={`iccid-${i}`} className="rotulo">
                        {varios ? `ICCID do ${nomeDoChip(chip, i, chips.length).toLowerCase()}` : 'Número do chip (ICCID)'}
                      </label>
                      <input
                        id={`iccid-${i}`}
                        inputMode="numeric"
                        autoComplete="off"
                        placeholder="8955 0000 0000 0000 000"
                        className={`${classeCampo(`chips.${i}.iccid`)} font-mono tracking-wider`}
                        value={form.iccids[i] ?? ''}
                        onChange={(e) => alterarIccid(i, e.target.value)}
                      />
                      <Erro campo={`chips.${i}.iccid`} />
                    </div>
                  ))}
                </section>
              )}

              <section className="space-y-7">
                <div>
                  <h2 className="titulo">Ativação</h2>
                  <p className="subtitulo">Quando o chip deve começar a funcionar e para onde você vai.</p>
                </div>

                {varios && (
                  <label className="flex cursor-pointer items-start gap-3 rounded-lg bg-marca-claro px-4 py-3.5 text-sm font-light text-slate-700">
                    <input
                      type="checkbox"
                      className="caixa mt-px"
                      checked={form.mesmos}
                      onChange={(e) => alternarMesmos(e.target.checked)}
                    />
                    <span>
                      Usar a <span className="font-normal text-slate-900">mesma data de ativação e os mesmos destinos</span> para
                      os {chips.length} chips
                    </span>
                  </label>
                )}

                {usaComum ? (
                  <CamposAtivacao
                    id="comum"
                    valor={form.comum}
                    cobertura={comum}
                    dias={varios ? null : chips[0]?.plano?.dias ?? null}
                    erroData={erroAtivacao('travel_start')}
                    erroPaises={erroAtivacao('countries')}
                    onChange={alterarComum}
                  />
                ) : (
                  chips.map((chip, i) => (
                    <div key={i} className="space-y-6 rounded-xl border border-slate-200 px-4 pb-5 pt-4 sm:px-5">
                      <div className="flex items-center gap-3">
                        <Capa tipo={chip.tipo} pequena />
                        <div className="min-w-0">
                          <p className="text-[15px] text-slate-900">{nomeDoChip(chip, i, chips.length)}</p>
                          <p className="truncate text-xs font-light text-slate-500">
                            {[chip.plano?.destino, chip.plano?.dias && `${chip.plano.dias} dias`, chip.plano?.franquia].filter(Boolean).join(' · ')}
                          </p>
                        </div>
                      </div>
                      <CamposAtivacao
                        id={`chip-${i}`}
                        valor={form.chips[i] ?? ATIVACAO_VAZIA}
                        cobertura={chip.plano?.paises ?? []}
                        dias={chip.plano?.dias ?? null}
                        erroData={erroAtivacao('travel_start', i)}
                        erroPaises={erroAtivacao('countries', i)}
                        onChange={(parte) => alterarChip(i, parte)}
                      />
                    </div>
                  ))
                )}

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
              <div className="flex items-baseline justify-between gap-3">
                <h2 className="text-xl font-light text-slate-900">{varios ? 'Seus chips' : 'Seu plano'}</h2>
                <span className="text-xs font-light text-slate-400">pedido final {consulta.pedidoFinal}</span>
              </div>

              <ul className="mt-6 space-y-5">
                {chips.map((chip, i) => {
                  const a = ativacaoDo(i);
                  const fim = fimDaVigencia(a.travel_start, chip.plano?.dias);
                  return (
                    <li key={i} className="flex gap-4">
                      <Capa tipo={chip.tipo} pequena={varios} />
                      <div className="min-w-0 flex-1">
                        <p className="text-[15px] leading-snug text-slate-900">{chip.plano?.destino || TIPO_TEXTO[chip.tipo]}</p>
                        <p className="mt-0.5 text-xs font-light leading-snug text-slate-500">
                          {varios
                            ? [nomeDoChip(chip, i, chips.length), chip.plano?.dias && `${chip.plano.dias} dias`, chip.plano?.franquia].filter(Boolean).join(' · ')
                            : chip.plano?.titulo || escolhido?.titulo}
                        </p>
                        {chip.iccid && <p className="mt-0.5 font-mono text-[11px] text-slate-400">{chip.iccid}</p>}
                        {varios && fim && (
                          <p className="mt-1 text-xs font-light text-marca">
                            {formatarDataBR(a.travel_start)} até {formatarDataBR(fim)}
                          </p>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>

              {!varios && chips[0] && (
                <>
                  <dl className="mt-6 space-y-3 text-sm">
                    <Linha rotulo="Período" valor={chips[0].plano?.dias ? `${chips[0].plano.dias} dias` : '—'} />
                    <Linha rotulo="Internet" valor={chips[0].plano?.franquia || '—'} />
                    <Linha rotulo="Ativação" valor={form.comum.travel_start ? formatarDataBR(form.comum.travel_start) : '—'} />
                  </dl>
                  <div className="mt-5 border-t border-slate-300/70 pt-5">
                    <Linha
                      rotulo="Válido até"
                      valor={formatarDataBR(fimDaVigencia(form.comum.travel_start, chips[0].plano?.dias)) || '—'}
                      forte
                    />
                  </div>
                </>
              )}

              {varios && (
                <div className="mt-6 border-t border-slate-300/70 pt-5">
                  <Linha rotulo="Total" valor={`${chips.length} chips`} forte />
                </div>
              )}

              {consulta.jaEnviados > 0 && (
                <p className="mt-5 rounded-lg bg-white px-3 py-2.5 text-xs font-light leading-relaxed text-slate-500">
                  {consulta.jaEnviados} chip{consulta.jaEnviados > 1 ? 's' : ''} deste pedido já {consulta.jaEnviados > 1 ? 'foram cadastrados' : 'foi cadastrado'}.
                </p>
              )}
              {chips.some((c) => c.jaCadastrado) && (
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
                {carregando ? 'Enviando…' : varios ? `Enviar cadastro dos ${chips.length} chips` : 'Enviar cadastro'}
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
                {resultado.chips.length > 1
                  ? `Recebemos os dados dos ${resultado.chips.length} chips. Nossa equipe confere e segue com a ativação.`
                  : 'Recebemos os seus dados. Nossa equipe confere e segue com a ativação.'}
              </p>
            </div>
            <ul className="resumo space-y-2 !p-4 text-sm font-light text-slate-600">
              {resultado.chips.map((c, i) => (
                <li key={i}>
                  {resultado.chips.length > 1 && <span className="text-slate-400">Chip {i + 1} · </span>}
                  Ativação em <span className="font-normal text-slate-900">{formatarDataBR(c.travel_start)}</span>
                  {c.vigenciaFim && (
                    <>
                      {' '}· válido até <span className="font-normal text-slate-900">{formatarDataBR(c.vigenciaFim)}</span>
                    </>
                  )}
                </li>
              ))}
            </ul>
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

function ErroTexto({ texto }: { texto?: string }) {
  return texto ? <p className="mt-1.5 text-xs text-red-600">{texto}</p> : null;
}

/** Data de ativação e países de um chip — ou de todos, com "mesmos dados". */
function CamposAtivacao({
  id,
  valor,
  cobertura,
  dias,
  erroData,
  erroPaises,
  onChange,
}: {
  id: string;
  valor: Ativacao;
  cobertura: string[];
  /** Período do plano, para mostrar até quando vale. Nulo = não mostra. */
  dias: number | null;
  erroData?: string;
  erroPaises?: string;
  onChange: (parte: Partial<Ativacao>) => void;
}) {
  const [filtro, setFiltro] = useState('');
  const visiveis = useMemo(() => {
    const f = chaveTexto(filtro);
    return f ? cobertura.filter((p) => chaveTexto(p).includes(f)) : cobertura;
  }, [cobertura, filtro]);
  const fim = fimDaVigencia(valor.travel_start, dias);

  function alternar(pais: string) {
    onChange({ countries: valor.countries.includes(pais) ? valor.countries.filter((p) => p !== pais) : [...valor.countries, pais] });
  }

  return (
    <>
      <div className="grupo">
        <label htmlFor={`travel_start-${id}`} className="rotulo">Data de ativação</label>
        <input
          id={`travel_start-${id}`}
          type="date"
          min={hojeIso()}
          className={`campo ${erroData ? 'campo-erro' : ''}`}
          value={valor.travel_start}
          onChange={(e) => onChange({ travel_start: e.target.value })}
        />
        <ErroTexto texto={erroData} />
        {fim && (
          <p className="ajuda">
            Válido de {formatarDataBR(valor.travel_start)} até {formatarDataBR(fim)} · {dias} dias
          </p>
        )}
      </div>

      <div className="grupo">
        <span className="rotulo">Países que vai visitar</span>
        {cobertura.length >= 1 ? (
          <div className={`rounded-lg border px-4 pb-4 pt-5 ${erroPaises ? 'border-red-400' : 'border-slate-400/70'}`}>
            {cobertura.length === 1 ? (
              <div className="flex items-center gap-2 text-sm font-light text-slate-500">
                <span className="inline-flex items-center gap-1.5 rounded-full bg-marca px-3 py-1.5 text-sm text-white">
                  <Icone nome="check" className="h-3.5 w-3.5" /> {cobertura[0]}
                </span>
                incluído no plano
              </div>
            ) : (
              <>
                <div className="mb-3 flex items-center justify-between gap-2 text-xs font-light text-slate-400">
                  <span>O plano cobre {cobertura.length} países. Toque para marcar.</span>
                  {valor.countries.length > 0 && (
                    <span className="shrink-0 rounded-full bg-marca-claro px-2 py-0.5 text-marca">
                      {valor.countries.length} selecionado{valor.countries.length > 1 ? 's' : ''}
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
                      value={filtro}
                      onChange={(e) => setFiltro(e.target.value)}
                    />
                  </div>
                )}
                <div className="flex max-h-60 flex-wrap gap-2 overflow-y-auto">
                  {visiveis.map((p) => {
                    const marcado = valor.countries.includes(p);
                    return (
                      <button
                        key={p}
                        type="button"
                        aria-pressed={marcado}
                        onClick={() => alternar(p)}
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
                  {visiveis.length === 0 && <p className="text-sm font-light text-slate-400">Nenhum país com esse nome no plano.</p>}
                </div>
              </>
            )}
          </div>
        ) : (
          <input
            id={`countries-${id}`}
            placeholder="Ex.: Portugal, Espanha"
            className={`campo ${erroPaises ? 'campo-erro' : ''}`}
            value={valor.countries_texto}
            onChange={(e) => onChange({ countries_texto: e.target.value })}
          />
        )}
        <ErroTexto texto={erroPaises} />
      </div>
    </>
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
function Capa({ tipo, pequena = false, quantidade = 1 }: { tipo: TipoChip; pequena?: boolean; quantidade?: number }) {
  return (
    <span
      className={`relative flex shrink-0 items-center justify-center rounded-md bg-gradient-to-br from-marca to-marca-profundo text-white ${
        pequena ? 'h-12 w-10' : 'h-20 w-16'
      }`}
    >
      <Icone nome={tipo === 'fisico' ? 'chip' : 'esim'} className={pequena ? 'h-5 w-5' : 'h-7 w-7'} />
      {quantidade > 1 && (
        <span className="absolute -right-1.5 -top-1.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-white px-1 text-[11px] font-medium text-marca ring-1 ring-marca-borda">
          {quantidade}
        </span>
      )}
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
