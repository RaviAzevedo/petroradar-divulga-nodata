import CofreClient from "./CofreClient";

// force-dynamic: Vercel CLI 53.1.1 + Next 16.2.3 falha com "Unable to find lambda
// for route" quando uma página estática client component coexiste com subpaths
// dinâmicos ([id], novo). O wrapper server component + dynamic cria a lambda.
export const dynamic = "force-dynamic";

export default function Page() {
  return <CofreClient />;
}
