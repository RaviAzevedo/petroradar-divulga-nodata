"use client";

import { RouteError } from "@/components/shared/RouteError";

export default function AdminError(props: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <RouteError title="Erro no painel admin" {...props} />;
}
