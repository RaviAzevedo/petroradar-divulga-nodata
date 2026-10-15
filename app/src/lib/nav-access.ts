/**
 * RBAC de navegação — fonte única da regra rota→papéis, consumida pela
 * Sidebar e pelo CommandPalette (antes cada um mantinha a própria lista e a
 * palette vazava atalhos de rotas restritas, ex.: Famílias CRC, Cofre).
 *
 * Rotas fora da lista são liberadas para qualquer usuário autenticado; as
 * páginas/APIs continuam sendo a barreira de segurança real — aqui é só UX
 * (não oferecer atalho que "rebate" em redirect/403).
 */

import { isAdmin, isConformidade, podeVisualizar } from "@/lib/permissions";

const ROTAS_RESTRITAS: Record<string, (role: string) => boolean> = {
  // Acervo: busca semântica é interna (barra EXTERNO); habilitação é Conformidade
  "/acervo":                 podeVisualizar,
  "/acervo/painel":          isConformidade,
  "/acervo/operacoes":       isConformidade,
  "/acervo/familias":        isConformidade,
  "/acervo/cofre":           isConformidade,
  // 0043 (onda 4, D5): a tela mostra nome, CREA e formacao de pessoas, e o
  // `layout.tsx` do segmento barra em isConformidade — sem esta linha a Sidebar
  // ofereceria o atalho a TECNICO/ORCAMENTISTA, que rebateriam no redirect("/").
  "/acervo/profissionais":   isConformidade,
  // Admin
  "/admin/saude-scraper":    isAdmin,
};

/**
 * true se o papel pode acessar a rota. `role` undefined (sessão ainda
 * carregando) esconde as rotas restritas até a sessão resolver.
 */
export function podeAcessarRota(href: string, role: string | undefined): boolean {
  const regra = ROTAS_RESTRITAS[href];
  if (!regra) return true;
  return !!role && regra(role);
}
