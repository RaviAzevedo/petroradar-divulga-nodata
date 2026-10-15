import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { isConformidade, podeGerenciarDocumentosHabilitacao } from "@/lib/permissions";
import { formatZodErrors } from "@/lib/conformidade/cofre/validations";
import { FiltrosProfissionalSchema } from "@/lib/conformidade/profissionais/validations";
import { listProfissionais } from "@/lib/conformidade/profissionais/queries";
import {
  ProfissionaisClient,
  type EntradaProfissionais,
  type ResultadoProfissionais,
} from "./ProfissionaisClient";

// A lista lê o banco a cada abertura: contagem de documentos visíveis e
// situação mudam a cada vínculo criado, e um snapshot estático mentiria.
export const dynamic = "force-dynamic";

type SearchParams = Record<string, string | string[] | undefined>;

interface PageProps {
  searchParams: Promise<SearchParams>;
}

/** Só o primeiro valor de cada chave conta (`?x=a&x=b` → "a"). */
function primeiroValor(sp: SearchParams): (chave: string) => string | undefined {
  return (chave) => {
    const v = sp[chave];
    return Array.isArray(v) ? v[0] : v;
  };
}

/**
 * `ativo` e `comDocumento` são lidos FORA do zod, exatamente como a rota
 * (§5.4) faz: `"1"`/`"true"` ligam, `"0"`/`"false"` desligam e **ausente é
 * sem filtro**, nunca `true`. Um `z.coerce.boolean()` aqui transformaria
 * `?ativo=0` em `true` (truthiness da string) e a tela esconderia os inativos
 * sem ninguém ter pedido — corte escondido é o que Q10.3 proíbe.
 */
function lerBooleano(valor: string | undefined): boolean | undefined {
  if (valor === "1" || valor === "true") return true;
  if (valor === "0" || valor === "false") return false;
  return undefined;
}

/**
 * /acervo/profissionais — a lista de responsáveis técnicos (spec ONDA-4 §7.5).
 *
 * Server component que chama `listProfissionais()` DIRETO, sem passar pela
 * própria API — o mesmo desenho da aba "Verificar exigência" (onda 2 §1g) e da
 * bancada (onda 3). Duas consequências deliberadas: o filtro é decidido num só
 * lugar (o MESMO `FiltrosProfissionalSchema` da rota, então a tela não aceita
 * o que a API recusa nem o contrário) e a tela funciona mesmo que o NGINX
 * ainda não tenha as `location` de §5.9, porque a página lê o banco.
 *
 * O guard do segmento vive em `layout.tsx`; a sessão é relida aqui porque o
 * `role` é argumento das queries (`restricaoVisivel`) — a contagem de
 * documentos de cada profissional é sempre a do papel de quem olha.
 */
export default async function ProfissionaisPage({ searchParams }: PageProps) {
  const session = await auth();
  if (!session?.user) redirect("/login");
  if (!isConformidade(session.user.role)) redirect("/");

  const sp = await searchParams;
  const primeiro = primeiroValor(sp);

  const parsed = FiltrosProfissionalSchema.safeParse({
    busca:        primeiro("busca") || undefined,
    ativo:        lerBooleano(primeiro("ativo")),
    comDocumento: lerBooleano(primeiro("comDocumento")),
    limit:        primeiro("limit") || undefined,
    offset:       primeiro("offset") || undefined,
  });

  // Erro de forma chega à tela como `detalhes` campo a campo, igual ao 422 da
  // rota — o client renderiza cada mensagem no seu campo.
  let resultado: ResultadoProfissionais;
  if (parsed.success) {
    const { profissionais, total } = await listProfissionais(parsed.data, session.user.role);
    resultado = { estado: "ok", filtros: parsed.data, profissionais, total };
  } else {
    resultado = { estado: "erro", detalhes: formatZodErrors(parsed.error) };
  }

  // O que veio na URL, cru — estado inicial dos controles de filtro.
  const entrada: EntradaProfissionais = {
    busca:        primeiro("busca") ?? "",
    ativo:        primeiro("ativo") ?? "",
    comDocumento: primeiro("comDocumento") ?? "",
  };

  /**
   * Hoje este booleano é SEMPRE `true` para quem chega aqui: o `layout.tsx` do
   * segmento barra em `isConformidade`, e `isConformidade` ⊂
   * `podeGerenciarDocumentosHabilitacao`. Ele existe assim mesmo porque a
   * condição do botão tem de nomear a permissão de que o botão depende — se um
   * dia o guard do segmento afrouxar, o botão não vai junto sozinho. A barreira
   * real continua sendo a rota (§5.4), que revalida.
   */
  const podeGerenciar = podeGerenciarDocumentosHabilitacao(session.user.role);

  return (
    <div className="flex flex-col h-full">
      <ProfissionaisClient entrada={entrada} resultado={resultado} podeGerenciar={podeGerenciar} />
    </div>
  );
}
