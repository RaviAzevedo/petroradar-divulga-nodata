import { notFound, redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { isConformidade, podeGerenciarDocumentosHabilitacao } from "@/lib/permissions";
import { ehUuid } from "@/lib/conformidade/operacoes/validations";
import { curriculoDoProfissional } from "@/lib/conformidade/profissionais/queries";
import { CurriculoClient } from "./CurriculoClient";

// O currículo lê o banco a cada abertura: vínculo novo, atividade nova e
// medida confirmada mudam a hierarquia e os totais no mesmo instante.
export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }> };

/**
 * /acervo/profissionais/[id] — o currículo técnico do RT (spec ONDA-4 §7.7).
 *
 * Server component que chama `curriculoDoProfissional()` DIRETO: é a MESMA
 * função que o relatório C1 (§5.10) usa, então tela e anexo de habilitação
 * nunca discordam sobre o que é o currículo (Q10.6). O `role` vai junto
 * porque `restricaoVisivel` é a única fonte da regra de documento restrito —
 * a hierarquia, as contagens e os totais são sempre os do papel de quem olha.
 *
 * `ehUuid` falso ou currículo nulo → `notFound()` (o 404 do Next, não um
 * redirect): id inexistente e id malformado recebem a MESMA resposta, como as
 * rotas fazem (§5.5).
 */
export default async function CurriculoProfissionalPage({ params }: Props) {
  const session = await auth();
  if (!session?.user) redirect("/login");
  if (!isConformidade(session.user.role)) redirect("/");

  const { id } = await params;
  if (!ehUuid(id)) notFound();

  const curriculo = await curriculoDoProfissional(id, session.user.role);
  if (!curriculo) notFound();

  // Mesma nota de §7.1: hoje é sempre `true` para quem passa pelo `layout.tsx`
  // do segmento, mas a condição do botão tem de nomear a permissão de que o
  // botão depende. A barreira real é a rota (§5.5), que revalida.
  const podeGerenciar = podeGerenciarDocumentosHabilitacao(session.user.role);

  return <CurriculoClient curriculo={curriculo} podeGerenciar={podeGerenciar} />;
}
