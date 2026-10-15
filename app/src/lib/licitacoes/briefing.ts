/**
 * Geração de briefing (markdown + JSON) a partir da análise IA persistida.
 *
 * O pacote de orçamento (bridge para as ferramentas de orçamento e de
 * briefing/checklist de proposta) embute um briefing.md legível e um briefing.json
 * estruturado derivados de `analises_ia`. Reaproveitamos o contrato do tipo
 * `AnaliseResult` de claude.ts (consumido pela rota de análise) como fonte de
 * verdade do shape — aqui reconstruímos a partir da linha persistida.
 *
 * Nenhuma chamada a IA aqui: trabalha 100% sobre dados já salvos.
 */

import type { AnaliseResult } from "./claude";

/** Subconjunto da linha `analises_ia` necessário para montar o briefing. */
import type {
  CondicaoDeParticipar,
  CondicaoFamilia,
  VeredictoFamilia,
} from "./habilitacao-familias";

/** Rótulo e símbolo de cada veredito. O símbolo é o que se lê primeiro. */
const VEREDITO_ROTULO: Record<VeredictoFamilia | "SEM_FAMILIA", string> = {
  PODE:              "✅ PODE PARTICIPAR",
  PODE_COM_RESSALVA: "🟡 PODE, COM RESSALVA",
  RISCO:             "🟠 RISCO DE INABILITAÇÃO",
  NAO_PODE:          "⛔ NÃO PODE PARTICIPAR",
  A_APURAR:          "❔ A APURAR",
  SEM_FAMILIA:       "❔ SEM FAMÍLIA IDENTIFICADA",
};

export interface AnaliseRow {
  resumo:               string | null;
  objetoDetalhado:      string | null;
  checklist:            unknown;
  requisitos:           unknown;
  criteriosHabilitacao: unknown;
  criteriosJulgamento:  string | null;
  valorEstimado:        string | null;
  prazos:               unknown;
  riscos:               unknown;
  recomendacao:         string | null;
  modeloUsado:          string | null;
  /**
   * PROCEDÊNCIA (0032) — e OBRIGATÓRIOS de propósito, não opcionais.
   *
   * "ANEXOS" = a análise leu os documentos do edital; "OBJETO" = leu só a linha
   * de objeto (poucas dezenas de caracteres) e o briefing é PARCIAL; null =
   * análise anterior à 0032, procedência desconhecida.
   *
   * Por que obrigatórios: a tarja "BRIEFING PARCIAL — SEM LASTRO DOCUMENTAL"
   * (abaixo, e a irmã em briefing-pdf.ts) depende deste campo. Enquanto foi
   * `fonteTexto?`, os QUATRO montadores de AnaliseRow o omitiram — e o
   * TypeScript aceitou em silêncio, porque omitir opcional é legal. O teste
   * virava `undefined === "OBJETO"`, sempre falso, e a tarja era inalcançável
   * POR CONSTRUÇÃO: compilada, no ar, e incapaz de acender.
   *
   * Obrigatório, o compilador acusa qualquer montador que esqueça — foi assim
   * que o quarto (checklist-oficial) apareceu, depois de uma auditoria inteira
   * ter listado três. É o mesmo remédio que `erroParse`/`schemaVersao` já
   * receberam depois do mesmo defeito (ver executar-analise.ts).
   */
  fonteTexto:           string | null;
  charsEntrada:         number | null;
  erroParse:            boolean | null;
  schemaVersao:         number | null;
  probVitoria:          number | null;
  analisadoEm:          Date | null;
}

export interface BriefingMeta {
  numero:  string;
  objeto:  string | null;
  empresa: string | null;
  segmento: string | null;
}

/** Tipo do JSON estruturado embutido no ZIP. */
export interface BriefingJson {
  meta: BriefingMeta & { geradoEm: string; modeloUsado: string | null; erroParse: boolean };
  analise: Partial<AnaliseResult>;
  probVitoria: number | null;
}

function toStringArray(v: unknown): string[] {
  if (Array.isArray(v)) {
    return v
      .map((x) => (typeof x === "string" ? x : x == null ? "" : JSON.stringify(x)))
      .filter((s) => s.length > 0);
  }
  return [];
}

function toRiscos(v: unknown): Array<{ descricao: string; classificacao: string }> {
  if (!Array.isArray(v)) return [];
  return v.map((r) => {
    if (r && typeof r === "object" && "descricao" in r) {
      const o = r as { descricao?: unknown; classificacao?: unknown };
      return {
        descricao: String(o.descricao ?? ""),
        classificacao: String(o.classificacao ?? "MEDIO"),
      };
    }
    return { descricao: String(r ?? ""), classificacao: "MEDIO" };
  });
}

/**
 * Monta o JSON estruturado do briefing reaproveitando o shape de AnaliseResult.
 */
export function montarBriefingJson(meta: BriefingMeta, a: AnaliseRow): BriefingJson {
  const checklist =
    a.checklist && typeof a.checklist === "object" ? (a.checklist as Record<string, unknown>) : {};

  const analise: Partial<AnaliseResult> = {
    resumo_executivo:      a.resumo ?? "",
    objeto_detalhado:      a.objetoDetalhado ?? "",
    requisitos_tecnicos:   toStringArray(a.requisitos),
    criterios_habilitacao: toStringArray(a.criteriosHabilitacao),
    criterios_julgamento:  a.criteriosJulgamento ?? "",
    valor_estimado:        a.valorEstimado ?? "",
    prazos_importantes:    toStringArray(a.prazos),
    riscos_alertas:        toRiscos(a.riscos),
    recomendacao:          a.recomendacao ?? "",
    checklist,
    _erro_parse:           a.erroParse ?? false,
    _schema_versao:        a.schemaVersao ?? 1,
  };

  return {
    meta: {
      ...meta,
      geradoEm:    new Date().toISOString(),
      modeloUsado: a.modeloUsado,
      erroParse:   a.erroParse ?? false,
    },
    analise,
    probVitoria: a.probVitoria,
  };
}

/** Renderiza o briefing em markdown legível (consumido pelas skills Proponente). */
/**
 * A seção de habilitação por família. Separada para o PDF poder reusar a mesma
 * ordem e as mesmas frases — divergir entre os dois formatos do MESMO briefing
 * seria a pior espécie de bug: cada leitor decide com um documento diferente.
 */
export function linhasDeHabilitacao(h: CondicaoDeParticipar): string[] {
  const linhas: string[] = [];
  const p = (t: string) => linhas.push(t);

  p("## Temos condição de participar?");
  p("");
  p(`**${VEREDITO_ROTULO[h.vereditoGeral]}** — ${h.resumo}`);
  p("");
  p(
    "> Veredito por FAMÍLIA CRC, cruzando o cadastro da Proponente com o acervo de " +
    "atestados. Habilitação é elo mais fraco: o veredito acima é o PIOR entre as " +
    "famílias exigidas, não a média.",
  );
  if (h.semProvaConfirmadaNoSistema) {
    p(">");
    p(
      "> ⚠ **Nenhum vínculo documento↔família foi confirmado por uma pessoa ainda** " +
      "(`documentos_familias` está vazia). Tudo que aparece abaixo como lastro é " +
      "INDÍCIO da máquina: serve para orientar a busca do atestado, **não** para " +
      "afirmar habilitação nem para sustentar um NO-GO.",
    );
  }
  p("");

  if (h.familias.length === 0) return linhas;

  if (h.dataReferencia) {
    p(`Validade do CRC medida contra **${h.dataReferencia.toLocaleDateString("pt-BR")}** (data de referência da licitação).`);
    p("");
  }

  for (const f of h.familias) {
    p(`### ${f.codigo} — ${f.nome ?? "(sem nome no catálogo)"}`);
    p("");
    p(`**${VEREDITO_ROTULO[f.veredito]}** · ${f.porque}`);
    p("");
    const fatos: string[] = [];
    fatos.push(`Itens desta licitação na família: ${f.itens}`);
    fatos.push(
      f.cadastrada
        ? `Cadastro: ${f.statusCadastro ?? "—"}${f.statusFluxoCrc ? ` (fluxo ${f.statusFluxoCrc})` : ""}`
        : "Cadastro: **não temos CRC nesta família**",
    );
    if (f.validadeFim) {
      const folga =
        f.diasDeFolga == null
          ? ""
          : f.diasDeFolga < 0
            ? ` — **vencido ${Math.abs(f.diasDeFolga)} dias antes da licitação**`
            : ` (${f.diasDeFolga} dias de folga)`;
      fatos.push(`Validade do CRC: ${f.validadeFim.toLocaleDateString("pt-BR")}${folga}`);
    }
    fatos.push(
      f.provasConfirmadas > 0
        ? `Provas confirmadas no acervo: ${f.provasConfirmadas}`
        : f.indicios > 0
          ? `Indícios no acervo: ${f.indicios}${f.melhorVeredito ? ` (melhor: ${f.melhorVeredito})` : ""} — sem revisão humana`
          : f.avaliada
            ? "Acervo lido contra esta família: **nada a sustenta**"
            : "Acervo **nunca consultado** sobre esta família",
    );
    if (f.grupo) fatos.push(`Grupo: ${f.grupo}`);
    for (const t of fatos) p(`- ${t}`);
    p("");
    if (f.escopo) {
      p(`**Escopo oficial da Petrobras:** ${f.escopo}`);
      p("");
    }
    if (f.justificativa) {
      p(`**Por que o acervo sustenta:** ${f.justificativa}`);
      p("");
    }
  }
  return linhas;
}

export function montarBriefingMarkdown(
  meta: BriefingMeta,
  a: AnaliseRow,
  /**
   * OBRIGATÓRIO, aceitando `null` explícito — nunca omissão.
   *
   * Mesmo remédio de `fonteTexto`: parâmetro opcional é esquecido em silêncio
   * pelos montadores, e a seção some do documento sem que nada acuse. Com o
   * `null` obrigatório, cada chamador tem de DECIDIR se consegue calcular a
   * habilitação, e essa decisão fica visível no código.
   */
  habilitacao: CondicaoDeParticipar | null,
): string {
  const linhas: string[] = [];
  const p = (s: string) => linhas.push(s);

  p(`# Briefing de Licitação — ${meta.numero}`);
  p("");
  p(`> Gerado automaticamente pelo Petro Radar em ${new Date().toLocaleString("pt-BR")}.`);
  if (a.erroParse) {
    p(">");
    p("> ⚠ **Atenção:** a análise foi marcada com `erro_parse` — revise manualmente os campos abaixo.");
  }
  // Aviso de PROCEDÊNCIA (0032). Um briefing feito sobre a linha de objeto tem
  // as mesmas 12 seções de um feito sobre o edital inteiro — sem este aviso,
  // nada no documento distingue os dois, e o leitor confia igual nos dois.
  if (a.fonteTexto === "OBJETO") {
    p(">");
    p(`> 🚨 **BRIEFING PARCIAL — SEM LASTRO DOCUMENTAL.** Esta análise foi feita apenas sobre a linha de objeto da licitação (${a.charsEntrada ?? "?"} caracteres), **não sobre os documentos do edital**. Trate tudo abaixo como indicativo e confirme no edital antes de decidir qualquer coisa.`);
  }
  p("");

  p("## Identificação");
  p("");
  p(`- **Número:** ${meta.numero}`);
  p(`- **Cliente/Empresa:** ${meta.empresa ?? "—"}`);
  p(`- **Segmento:** ${meta.segmento ?? "—"}`);
  if (meta.objeto) p(`- **Objeto:** ${meta.objeto}`);
  if (a.valorEstimado) p(`- **Valor estimado:** ${a.valorEstimado}`);
  if (a.probVitoria != null) p(`- **Probabilidade de vitória (heurística):** ${Math.round(a.probVitoria)}%`);
  p("");

  // A habilitação vem ANTES do resumo de propósito: quem abre um briefing está
  // decidindo ir ou não ir, e um resumo bonito de licitação em que não podemos
  // nos habilitar é tempo perdido lido na ordem errada.
  if (habilitacao) {
    for (const l of linhasDeHabilitacao(habilitacao)) p(l);
  }

  if (a.resumo) {
    p("## Resumo Executivo");
    p("");
    p(a.resumo);
    p("");
  }

  if (a.objetoDetalhado) {
    p("## Objeto Detalhado");
    p("");
    p(a.objetoDetalhado);
    p("");
  }

  const reqTec = toStringArray(a.requisitos);
  if (reqTec.length > 0) {
    p("## Requisitos Técnicos");
    p("");
    for (const r of reqTec) p(`- ${r}`);
    p("");
  }

  const crit = toStringArray(a.criteriosHabilitacao);
  if (crit.length > 0) {
    p("## Critérios de Habilitação");
    p("");
    for (const c of crit) p(`- ${c}`);
    p("");
  }

  if (a.criteriosJulgamento) {
    p("## Critério de Julgamento");
    p("");
    p(a.criteriosJulgamento);
    p("");
  }

  const prazos = toStringArray(a.prazos);
  if (prazos.length > 0) {
    p("## Prazos Importantes");
    p("");
    for (const pr of prazos) p(`- ${pr}`);
    p("");
  }

  const riscos = toRiscos(a.riscos);
  if (riscos.length > 0) {
    p("## Riscos e Alertas");
    p("");
    for (const r of riscos) p(`- **[${r.classificacao}]** ${r.descricao}`);
    p("");
  }

  if (a.recomendacao) {
    p("## Recomendação");
    p("");
    p(a.recomendacao);
    p("");
  }

  return linhas.join("\n");
}
