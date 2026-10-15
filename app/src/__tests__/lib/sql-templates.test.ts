import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Guarda contra um erro que já aconteceu CINCO vezes neste módulo: uma crase
 * dentro do SQL de um template literal do drizzle.
 *
 * Uma crase ali FECHA o template, e o SQL que vem depois passa a ser lido como
 * TypeScript. Às vezes o `tsc` acusa — e aí custa dois minutos. Às vezes ele
 * NÃO acusa, porque o resto ainda faz sentido sintático, e o defeito só aparece
 * em execução como "relation does not exist". Foi assim que `mapa.ts` chegou a
 * referenciar duas CTEs que não definia, compilando limpo.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * A PRIMEIRA VERSÃO DESTE TESTE ERA TAUTOLOGICAMENTE VERDE.
 *
 * Ela cortava o corpo do template ATÉ a primeira crase e então perguntava se
 * esse corpo continha uma crase. Por construção nunca continha: o teste não
 * tinha como falhar. Varreu 55 arquivos, deu tudo verde, e não pegou a quinta
 * ocorrência do bug (em `habilitacao-familias.ts`) — quem pegou foi o tsc.
 *
 * A lição é sobre o próprio teste: um guarda que nunca falha é indistinguível
 * de um guarda que funciona, e é PIOR que nenhum, porque dá licença para parar
 * de olhar. Todo teste-guarda precisa ser visto falhando ao menos uma vez — é
 * o que o bloco "deteccao" abaixo faz, plantando o defeito e exigindo o flagra.
 * ───────────────────────────────────────────────────────────────────────────
 *
 * COMO DETECTAR, já que lexicalmente a crase intrusa é idêntica à que fecha:
 * pelo que vem DEPOIS dela. Um template que fecha de verdade é seguido de
 * pontuação de JavaScript — `)`, `;`, `,`, `.`, `}` — ou de fim de linha. Um
 * template que "fechou" no meio de um comentário SQL é seguido de mais texto.
 * É esse resto que denuncia.
 *
 * A crase legítima existe: `${sql.raw(...)}` é interpolação aninhada. Por isso
 * o teste ignora o que está dentro de `${...}`.
 */
function arquivosTs(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return n === "node_modules" ? [] : arquivosTs(p);
    return p.endsWith(".ts") || p.endsWith(".tsx") ? [p] : [];
  });
}

/** Remove as interpolações `${...}`, onde crase é legítima. */
function semInterpolacao(texto: string): string {
  let fora = "";
  let profundidade = 0;
  for (let i = 0; i < texto.length; i++) {
    if (texto[i] === "$" && texto[i + 1] === "{") { profundidade++; i++; continue; }
    if (profundidade > 0) {
      if (texto[i] === "{") profundidade++;
      else if (texto[i] === "}") profundidade--;
      continue;
    }
    fora += texto[i];
  }
  return fora;
}

/** O que pode seguir uma crase que REALMENTE fecha um template. */
const CONTINUACAO_JS = /^[\s)\];,.}`]/;

/** As crases intrusas de um fonte. É esta função que os casos de detecção testam. */
export function crasesIntrusas(src: string): string[] {
  const problemas: string[] = [];
  const re = /sql`/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const inicio = m.index + m[0].length;
    const limpo = semInterpolacao(src.slice(inicio));
    const fim = limpo.indexOf("`");
    if (fim < 0) continue;

    const depois = limpo.slice(fim + 1);
    if (depois.length === 0) continue;          // fim de arquivo: nada a suspeitar
    if (CONTINUACAO_JS.test(depois)) continue;  // fechou de verdade

    const linhaAbertura = src.slice(0, inicio).split("\n").length;
    const trecho = depois.slice(0, 40).split("\n")[0];
    problemas.push(`template aberto na linha ${linhaAbertura}: crase seguida de "${trecho}"`);
  }
  return problemas;
}

describe("templates SQL não contêm crase solta", () => {
  const raiz = join(process.cwd(), "src");
  // O PRÓPRIO scanner fica de fora: ele carrega o padrão /sql`/ para procurar
  // aberturas, e esse literal de regex é indistinguível de uma abertura de
  // template para quem varre texto. Excluir a ferramenta da varredura que ela
  // faz é honesto; alternativa seria ensinar o scanner a pular literais de
  // regex, complexidade que não paga por um arquivo.
  const alvos = arquivosTs(raiz)
    .filter((p) => !p.endsWith("sql-templates.test.ts"))
    .filter((p) => readFileSync(p, "utf8").includes("sql`"));

  it("há arquivos com template SQL para verificar", () => {
    expect(alvos.length).toBeGreaterThan(0);
  });

  it.each(alvos.map((p) => [p.replace(raiz, "src"), p]))("%s", (_rotulo, caminho) => {
    expect(crasesIntrusas(readFileSync(caminho, "utf8"))).toEqual([]);
  });
});

describe("deteccao — o guarda tem de ser visto FALHANDO", () => {
  const CRASE = String.fromCharCode(96);

  it("acusa a crase de comentário SQL — o bug real, 5ª ocorrência", () => {
    const defeituoso = [
      "const r = await db.execute(sql" + CRASE,
      "  WITH exigidas AS (",
      "    -- As DUAS fontes, unidas. " + CRASE + "itens" + CRASE + " liga por id",
      "    SELECT 1",
      "  )",
      CRASE + ");",
    ].join("\n");
    expect(crasesIntrusas(defeituoso)).toHaveLength(1);
  });

  it("acusa crase que abre identificador citado no meio do SQL", () => {
    const defeituoso = "db.execute(sql" + CRASE + "SELECT " + CRASE + "max" + CRASE +
      "(n) FROM t" + CRASE + ");";
    expect(crasesIntrusas(defeituoso)).toHaveLength(1);
  });

  it("não acusa template legítimo de uma linha", () => {
    expect(crasesIntrusas("cond.push(sql" + CRASE + "true" + CRASE + ");")).toEqual([]);
  });

  it("não acusa template legítimo de várias linhas", () => {
    const ok = "const q = sql" + CRASE + "\n  SELECT 1\n" + CRASE + ";\nconst outro = 2;";
    expect(crasesIntrusas(ok)).toEqual([]);
  });

  it("não acusa crase dentro de interpolação", () => {
    const ok = "db.execute(sql" + CRASE + "SELECT ${sql.raw(" + CRASE + "1" + CRASE +
      ")} AS n" + CRASE + ");";
    expect(crasesIntrusas(ok)).toEqual([]);
  });

  it("não acusa template encadeado com .as()", () => {
    const ok = "const c = sql" + CRASE + "count(*)" + CRASE + '.as("n");';
    expect(crasesIntrusas(ok)).toEqual([]);
  });
});
