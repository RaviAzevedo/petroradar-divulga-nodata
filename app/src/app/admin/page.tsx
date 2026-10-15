import { redirect } from "next/navigation";

/** /admin → seção principal do Admin Center. */
export default function AdminPage() {
  redirect("/admin/usuarios");
}
