import { redirect } from "next/navigation";

/** A tela foi unificada em /acervo/familias. Link antigo continua valendo. */
export default function Page() {
  redirect("/acervo/familias");
}
