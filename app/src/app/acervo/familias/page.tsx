import FamiliasMapaClient from "./FamiliasMapaClient";

export const dynamic = "force-dynamic";

/**
 * A tela de famílias UNIFICADA.
 *
 * Antes eram duas: `/acervo/familias` listava só o CADASTRO e
 * `/acervo/familias/mapa` mostrava o mercado. Separadas, nenhuma respondia a
 * pergunta que decide dinheiro — a lista do cadastro é incapaz de mostrar a
 * família exigida em que não estamos, e o mapa não carregava validade nem
 * renovação.
 *
 * Agora é uma só, com as três situações como visões da mesma lista: ativas e
 * comprováveis, ativas sem comprovação, e não ativas.
 *
 * A lista detalhada do cadastro (com paginação e filtro por status) segue em
 * `/acervo/familias/cadastro` — não foi apagada, só deixou de ser a porta.
 */
export default function Page() {
  return <FamiliasMapaClient />;
}
