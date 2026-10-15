import Link from "next/link";
import { Trophy, ArrowRight } from "lucide-react";
import { db } from "@/db";
import { petronectLicResultado } from "@/db/schema";
import { sql, eq, desc } from "drizzle-orm";
import { normalizeCnpj } from "@/lib/format";
import { config } from "@/lib/config";

/**
 * Card de KPI: últimas vitórias OFICIAIS confirmadas da Proponente no
 * pipeline V2. Não inclui PENDING/legado — só vencedores com
 * confidence_level=OFFICIAL.
 *
 * Carrega no server (RSC); sem useState/useEffect.
 */
export async function VencedoresProponente() {
  const cnpjProp = normalizeCnpj(config.proponente.cnpj);

  const rows = await db
    .select({
      numero:             petronectLicResultado.numero,
      fornecedorVencedor: petronectLicResultado.fornecedorVencedor,
      valorVencedor:      petronectLicResultado.valorVencedor,
      statusResultado:    petronectLicResultado.statusResultado,
      atualizadoEm:       petronectLicResultado.atualizadoEm,
    })
    .from(petronectLicResultado)
    .where(sql`REGEXP_REPLACE(${petronectLicResultado.cnpjVencedor}, '[^0-9]', '', 'g') = ${cnpjProp}
               AND ${petronectLicResultado.confidenceLevel} = 'OFFICIAL'`)
    .orderBy(desc(petronectLicResultado.atualizadoEm))
    .limit(5);

  const fmtBRL = (v: string | null) => {
    if (!v) return "—";
    const n = parseFloat(v);
    if (isNaN(n)) return "—";
    return n.toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 2 });
  };

  return (
    <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden h-full flex flex-col">
      <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100 bg-gradient-to-r from-green-50/60 to-transparent">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-green-100 flex items-center justify-center">
            <Trophy className="h-4 w-4 text-green-700" />
          </div>
          <div>
            <h2 className="text-sm font-bold text-gray-900">Vitórias Proponente</h2>
            <p className="text-[11px] text-gray-400">Confirmadas pelo portal (V2)</p>
          </div>
        </div>
        <Link
          href="/resultados?confidence=OFFICIAL&cnpj_vencedor=11222333000181"
          className="text-xs font-medium text-green-700 hover:underline flex items-center gap-1"
        >
          Ver todas <ArrowRight className="h-3 w-3" />
        </Link>
      </div>

      <div className="flex-1 px-3 py-3">
        {rows.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-center">
            <Trophy className="h-10 w-10 text-gray-200 mb-3" />
            <p className="text-sm text-gray-400 font-medium">Nenhuma vitória oficial registrada ainda</p>
            <p className="text-[11px] text-gray-400 mt-1">
              Vitórias aparecem aqui quando o portal Petronect confirma
              (Homologada/Adjudicada).
            </p>
          </div>
        ) : (
          <div className="space-y-1">
            {rows.map((r) => (
              <Link
                key={r.numero}
                href={`/resultados?numero=${encodeURIComponent(r.numero)}`}
                className="flex items-center gap-3 py-2 px-3 rounded-xl hover:bg-green-50 transition-all border border-transparent hover:border-green-100 group"
              >
                <div className="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0 bg-green-100">
                  <Trophy className="h-3.5 w-3.5 text-green-600" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-mono text-xs font-bold text-gray-700 group-hover:text-gray-900">
                    {r.numero}
                  </p>
                  <p className="text-[10px] text-gray-400 truncate">
                    {r.statusResultado}
                  </p>
                </div>
                <span className="text-xs font-bold tabular-nums text-green-700 whitespace-nowrap">
                  {fmtBRL(r.valorVencedor)}
                </span>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
