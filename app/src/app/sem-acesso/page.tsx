import { Lock } from "lucide-react";

/**
 * /sem-acesso — destino dos gates de papel das páginas server-side.
 *
 * O papel EXTERNO não tem acesso a NENHUMA rota de dados internos (todas as
 * APIs de leitura usam requireVisualizar, que o barra), então não existe rota
 * "permitida" para onde redirecionar. Esta página estática (zero queries) evita
 * telas de 403 e loops de redirect (ex.: outras páginas redirecionam para /,
 * que agora também tem gate).
 */
export default function SemAcessoPage() {
  return (
    <div className="flex items-center justify-center py-24">
      <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-8 max-w-md text-center">
        <div className="mx-auto w-12 h-12 rounded-full bg-amber-50 flex items-center justify-center mb-4">
          <Lock className="h-6 w-6 text-brand-orange" />
        </div>
        <h1 className="text-lg font-bold text-brand-black mb-2">Acesso restrito</h1>
        <p className="text-sm text-gray-500">
          O seu perfil não tem permissão para visualizar este módulo.
          Se você acredita que deveria ter acesso, fale com um administrador
          do Petro Radar.
        </p>
      </div>
    </div>
  );
}
