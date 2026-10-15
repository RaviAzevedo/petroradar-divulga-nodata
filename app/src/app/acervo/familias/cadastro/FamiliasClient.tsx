"use client";

import { useState, useEffect, useCallback, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import Link from "next/link";
import {
  Plus, Search, X, Loader2, AlertCircle, RefreshCw,
  CalendarClock, ChevronLeft, ChevronRight, Map,
} from "lucide-react";
import { cn, formatDate, diasRestantes } from "@/lib/utils";
import { buttonVariants } from "@/components/ui/Button";
import { StatusFamiliaBadge, type StatusFamilia } from "@/components/conformidade/familias/StatusFamiliaBadge";

interface FamiliaListItem {
  id: string;
  codigoCrc: string;
  nome: string;
  descricao: string | null;
  nivel: "FAMILIA" | "SUBFAMILIA" | "GRUPO" | "ITEM";
  status: StatusFamilia;
  validadeFim: string | null;
  cadastroCorporativo: boolean;
  tags: string[] | null;
  criadoEm: string;
}

interface ApiResponse {
  data:  FamiliaListItem[];
  total: number;
  page:  number;
  limit: number;
  pages: number;
}

const STATUS_LABELS: Record<StatusFamilia, string> = {
  ATIVA:        "Ativa",
  EM_RENOVACAO: "Em renovação",
  SUSPENSA:     "Suspensa",
  VENCIDA:      "Vencida",
  REJEITADA:    "Rejeitada",
};

function prazoClasses(data: string | Date | null): string {
  if (!data) return "text-gray-400";
  const d = typeof data === "string" ? data : data.toISOString();
  const dias = diasRestantes(d);
  if (dias === null) return "text-gray-400";
  if (dias < 0)  return "text-red-600 font-bold";
  if (dias <= 30) return "text-red-600";
  if (dias <= 60) return "text-amber-600";
  return "text-gray-500";
}

function FamiliaRow({ f }: { f: FamiliaListItem }) {
  const dias = diasRestantes(f.validadeFim);

  return (
    <tr className="border-b border-gray-100 hover:bg-gray-50 transition-colors">
      <td className="px-4 py-3 whitespace-nowrap">
        <Link
          href={`/acervo/familias/${f.id}`}
          className="font-mono text-xs font-bold text-brand-orange hover:underline"
        >
          {f.codigoCrc}
        </Link>
      </td>

      <td className="px-4 py-3 max-w-md">
        <Link href={`/acervo/familias/${f.id}`}>
          <p className="text-sm font-medium text-gray-800 truncate hover:text-gray-900">
            {f.nome}
          </p>
        </Link>
        {f.descricao && (
          <p className="text-xs text-gray-400 line-clamp-1 mt-0.5">{f.descricao}</p>
        )}
      </td>

      <td className="px-4 py-3 whitespace-nowrap">
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-gray-100 text-gray-600 text-[10px] font-medium uppercase tracking-wide">
          {f.nivel.toLowerCase()}
        </span>
      </td>

      <td className="px-4 py-3 whitespace-nowrap">
        <StatusFamiliaBadge status={f.status} />
      </td>

      <td className="px-4 py-3 whitespace-nowrap">
        {f.validadeFim ? (
          <>
            <p className="text-xs text-gray-600">{formatDate(f.validadeFim)}</p>
            {dias !== null && (
              <p className={cn("text-xs mt-0.5", prazoClasses(f.validadeFim))}>
                {dias < 0 ? `${Math.abs(dias)}d atrás` : dias === 0 ? "Hoje!" : `${dias}d restantes`}
              </p>
            )}
          </>
        ) : (
          <span className="text-gray-300 text-xs">—</span>
        )}
      </td>

      <td className="px-4 py-3 whitespace-nowrap text-xs text-gray-500">
        {f.cadastroCorporativo ? "Corporativo" : "Simplificado"}
      </td>
    </tr>
  );
}

function FamiliasPaginaContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const [initialized, setInitialized] = useState(false);

  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [status, setStatus] = useState("");
  const [vencendoEm, setVencendoEm] = useState("");
  const [page, setPage] = useState(1);

  const [data, setData] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const s = searchParams.get("status");
    const b = searchParams.get("busca");
    const v = searchParams.get("vencendoEm");
    if (s) setStatus(s);
    if (b) { setSearch(b); setDebouncedSearch(b); }
    if (v) setVencendoEm(v);
    setInitialized(true);
  }, [searchParams]);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 400);
    return () => clearTimeout(timer);
  }, [search]);

  const updateURL = useCallback(() => {
    const p = new URLSearchParams();
    if (status)          p.set("status", status);
    if (debouncedSearch) p.set("busca", debouncedSearch);
    if (vencendoEm)      p.set("vencendoEm", vencendoEm);
    const qs = p.toString();
    router.replace(qs ? `/acervo/familias?${qs}` : "/acervo/familias", { scroll: false });
  }, [status, debouncedSearch, vencendoEm, router]);

  useEffect(() => {
    if (!initialized) return;
    updateURL();
  }, [initialized, updateURL]);

  const fetchData = useCallback(() => {
    const p = new URLSearchParams();
    p.set("page",  String(page));
    p.set("limit", "50");
    p.set("order", "codigo");
    p.set("dir",   "asc");
    if (debouncedSearch) p.set("busca", debouncedSearch);
    if (status)          p.set("status", status);
    if (vencendoEm)      p.set("vencendoEm", vencendoEm);

    setLoading(true);
    setError(null);

    fetch(`/api/conformidade/familias?${p}`)
      .then((r) => {
        if (!r.ok) throw new Error(`Erro ${r.status}`);
        return r.json();
      })
      .then((d: ApiResponse) => {
        setData(d);
        setLoading(false);
      })
      .catch((e) => {
        setError(e.message ?? "Erro ao carregar dados");
        setLoading(false);
      });
  }, [page, debouncedSearch, status, vencendoEm]);

  useEffect(() => { if (initialized) fetchData(); }, [initialized, fetchData]);
  useEffect(() => { if (initialized) setPage(1); }, [initialized, debouncedSearch, status, vencendoEm]);

  const temFiltro = Boolean(debouncedSearch || status || vencendoEm);

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between mb-5 flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-brand-black">Famílias CRC</h1>
          {data && !loading && (
            <p className="text-sm text-gray-500 mt-0.5">
              <span className="font-medium text-gray-700">{data.total.toLocaleString("pt-BR")}</span>{" "}
              família{data.total !== 1 ? "s" : ""} cadastrada{data.total !== 1 ? "s" : ""}
              {temFiltro && <span className="text-brand-orange ml-1">· filtros ativos</span>}
            </p>
          )}
        </div>

        <div className="flex items-center gap-2">
          {/* A lista ao lado mostra o CADASTRO. O mapa mostra o MERCADO — e é o
              único lugar onde aparece a família exigida em que não estamos
              cadastrados, que é o caso que custa licitação. */}
          <Link
            href="/acervo/familias"
            className={buttonVariants({ variant: "secondary", className: "shadow-sm" })}
          >
            <Map className="h-4 w-4" /> Visão unificada
          </Link>
          <Link href="/acervo/familias/nova" className={buttonVariants({ className: "shadow-sm" })}>
            <Plus className="h-4 w-4" /> Nova família
          </Link>
        </div>
      </div>

      {/* Barra de filtros */}
      <div className="bg-white rounded-xl border border-gray-200 mb-5 overflow-hidden">
        <div className="flex items-center gap-3 p-4 flex-wrap">
          <div className="relative flex-1 min-w-[220px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
            <input
              type="text"
              placeholder="Buscar por código, nome ou descrição..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Buscar"
              className="w-full pl-10 pr-4 py-2.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-orange/30 focus:border-brand-orange"
            />
          </div>

          <select
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            className="px-3 py-2.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-orange/30 text-gray-600"
          >
            <option value="">Todos os status</option>
            {Object.entries(STATUS_LABELS).map(([v, l]) => (
              <option key={v} value={v}>{l}</option>
            ))}
          </select>

          <div className="flex items-center gap-1.5 text-xs text-gray-500">
            <CalendarClock className="h-4 w-4" />
            <span>Vencendo em</span>
            <select
              value={vencendoEm}
              onChange={(e) => setVencendoEm(e.target.value)}
              className="px-2 py-1.5 text-xs border border-gray-200 rounded-md focus:outline-none focus:ring-2 focus:ring-brand-orange/30 text-gray-600"
            >
              <option value="">qualquer prazo</option>
              <option value="30">30 dias</option>
              <option value="60">60 dias</option>
              <option value="90">90 dias</option>
              <option value="180">180 dias</option>
            </select>
          </div>

          <button
            onClick={fetchData}
            disabled={loading}
            className="p-2.5 border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors disabled:opacity-40"
            title="Atualizar"
            aria-label="Atualizar"
          >
            <RefreshCw className={cn("h-4 w-4 text-gray-500", loading && "animate-spin")} />
          </button>

          {temFiltro && (
            <button
              onClick={() => { setSearch(""); setStatus(""); setVencendoEm(""); }}
              className="flex items-center gap-1 text-xs text-gray-400 hover:text-red-500 transition-colors"
              aria-label="Limpar filtros"
            >
              <X className="h-3.5 w-3.5" /> Limpar
            </button>
          )}
        </div>
      </div>

      {/* Erro */}
      {error && (
        <div className="flex items-center gap-3 bg-red-50 border border-red-200 rounded-xl p-4 mb-4 text-sm text-red-600">
          <AlertCircle className="h-5 w-5 flex-shrink-0" />
          {error}
          <button onClick={fetchData} className="ml-auto text-xs underline hover:no-underline">
            Tentar novamente
          </button>
        </div>
      )}

      {/* Loading */}
      {loading && (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-brand-orange" />
          <span className="ml-2 text-sm text-gray-500">Carregando...</span>
        </div>
      )}

      {/* Tabela */}
      {!loading && !error && data && data.total > 0 && (
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-200">
                  <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide whitespace-nowrap">Código CRC</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide">Nome / Descrição</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide">Nível</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide">Status</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide">Validade</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide">Cadastro</th>
                </tr>
              </thead>
              <tbody>
                {data.data.map((f) => <FamiliaRow key={f.id} f={f} />)}
              </tbody>
            </table>
          </div>

          {data.pages > 1 && (
            <div className="flex items-center justify-between px-4 py-3 border-t border-gray-200 bg-gray-50">
              <span className="text-xs text-gray-500">
                Página <span className="font-medium">{data.page}</span> de{" "}
                <span className="font-medium">{data.pages}</span>
                <span className="text-gray-400 ml-2">· {data.total.toLocaleString("pt-BR")} total</span>
              </span>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => setPage(Math.max(1, page - 1))}
                  disabled={page <= 1}
                  className="p-1.5 rounded-lg hover:bg-gray-200 disabled:opacity-30 transition-colors"
                  aria-label="Página anterior"
                >
                  <ChevronLeft className="h-4 w-4" />
                </button>
                <button
                  onClick={() => setPage(Math.min(data.pages, page + 1))}
                  disabled={page >= data.pages}
                  className="p-1.5 rounded-lg hover:bg-gray-200 disabled:opacity-30 transition-colors"
                  aria-label="Próxima página"
                >
                  <ChevronRight className="h-4 w-4" />
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Empty com filtro */}
      {!loading && !error && data?.total === 0 && temFiltro && (
        <div className="bg-white rounded-xl border border-gray-200 p-12 text-center">
          <p className="text-sm text-gray-500">Nenhuma família encontrada com os filtros aplicados.</p>
        </div>
      )}

      {/* Empty inicial */}
      {!loading && !error && data?.total === 0 && !temFiltro && (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <div className="w-16 h-16 rounded-full bg-gray-100 flex items-center justify-center mb-4">
            <Plus className="h-8 w-8 text-gray-400" />
          </div>
          <h3 className="text-lg font-semibold text-gray-700 mb-2">Nenhuma família CRC cadastrada</h3>
          <p className="text-sm text-gray-500 mb-6 max-w-md">
            Cadastre as famílias CRC da Proponente Petrobras para começar a cruzar com licitações
            e medir aderência automaticamente.
          </p>
          <Link
            href="/acervo/familias/nova"
            className={buttonVariants({ className: "gap-2 px-5 py-2.5" })}
          >
            <Plus className="h-4 w-4" /> Cadastrar primeira família
          </Link>
        </div>
      )}
    </div>
  );
}

export default function FamiliasPagina() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center py-16">
          <div className="w-5 h-5 border-2 border-gray-300 border-t-brand-orange rounded-full animate-spin" />
          <span className="ml-2 text-sm text-gray-500">Carregando...</span>
        </div>
      }
    >
      <FamiliasPaginaContent />
    </Suspense>
  );
}
