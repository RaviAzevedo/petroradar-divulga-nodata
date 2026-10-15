"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import {
  Download, FileText, ChevronDown, ChevronRight,
  Search, Filter, Loader2, AlertCircle, CheckSquare,
  Square, CheckCheck, X, FileDown, FolderArchive, Trash2,
} from "lucide-react";
import { cn, relevanciaColor } from "@/lib/utils";
import { faseColor } from "@/lib/format";
import { Button } from "@/components/ui/Button";

// ─── Tipos ────────────────────────────────────────────────────────────────────

interface Anexo {
  id: string;
  phioObjid: string | null;
  descricao: string | null;
  tamanhoBytes: number | null;
  baixadoEm: string | null;
}

interface LicitacaoRow {
  id: string;
  numero: string;
  objeto: string | null;
  empresa: string | null;
  fase: string | null;
  dataFim: string | null;
  relevancia: string | null;
  scoreInteresse: number | null;
  totalAnexos: number;
}

type DownloadStatus = "idle" | "downloading" | "ok" | "error";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const CIRCULAR_KEYWORDS = ["adendo", "circular", "esclarecimento", "comunicado", "errata", "retifica", "nota de"];

function isCircular(descricao: string | null): boolean {
  if (!descricao) return false;
  const d = descricao.toLowerCase();
  return CIRCULAR_KEYWORDS.some((k) => d.includes(k));
}

function sanitizeName(name: string): string {
  return name.replace(/[<>:"/\\|?*]/g, "_").replace(/\s+/g, " ").trim() || "arquivo";
}

async function fetchFileBlob(phio: string, filename: string): Promise<Blob | null> {
  try {
    const url = `/api/download?phio=${encodeURIComponent(phio)}&filename=${encodeURIComponent(filename)}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    return await res.blob();
  } catch {
    return null;
  }
}

/** Shape retornado por /api/licitacoes/anexos-batch (campos enxutos). */
interface AnexoBatch {
  id: string;
  phioObjid: string | null;
  descricao: string | null;
}

/**
 * Busca os anexos de várias licitações em UMA chamada (evita o N+1 de
 * /api/licitacoes/[id] por item). Retorna um Map licitacaoId → Anexo[].
 */
async function fetchAnexosBatch(ids: string[]): Promise<Map<string, Anexo[]>> {
  const out = new Map<string, Anexo[]>();
  if (ids.length === 0) return out;
  const res = await fetch("/api/licitacoes/anexos-batch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  const data: { licitacaoId: string; anexos: AnexoBatch[] }[] = json.data ?? [];
  for (const row of data) {
    out.set(
      row.licitacaoId,
      row.anexos.map((a) => ({ ...a, tamanhoBytes: null, baixadoEm: null })),
    );
  }
  return out;
}

// ─── Checkbox ────────────────────────────────────────────────────────────────

function Checkbox({ checked, onChange, label, size = "md" }: {
  checked: boolean;
  onChange: () => void;
  label: string;
  size?: "sm" | "md";
}) {
  const s = size === "sm" ? "h-4 w-4" : "h-5 w-5";
  return (
    <button type="button" aria-label={label} onClick={(e) => { e.stopPropagation(); onChange(); }}
      className="flex-shrink-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-orange/50 rounded">
      {checked ? (
        <div className={cn(s, "rounded bg-brand-orange text-white flex items-center justify-center")}>
          <svg viewBox="0 0 12 12" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M2 6l3 3 5-5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
      ) : (
        <div className={cn(s, "rounded border-2 border-gray-300 hover:border-brand-orange transition-colors")} />
      )}
    </button>
  );
}

// ─── Linha de arquivo ────────────────────────────────────────────────────────

function AnexoRow({ anx, selected, onSelect }: {
  anx: Anexo; selected: boolean;
  onSelect: (id: string, phio: string, filename: string) => void;
}) {
  const [status, setStatus] = useState<DownloadStatus>("idle");
  const [erro, setErro] = useState("");
  const nome = anx.descricao || `Arquivo_${anx.phioObjid?.slice(0, 8) ?? "?"}`;
  const circular = isCircular(anx.descricao);
  const phio = anx.phioObjid;

  async function handleDownload() {
    if (!phio) { setErro("ID ausente"); setStatus("error"); return; }
    setStatus("downloading"); setErro("");
    try {
      const blob = await fetchFileBlob(phio, nome);
      if (!blob) throw new Error("Falha ao baixar");
      const objUrl = URL.createObjectURL(blob);
      const a = document.createElement("a"); a.href = objUrl; a.download = nome;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      URL.revokeObjectURL(objUrl);
      setStatus("ok"); setTimeout(() => setStatus("idle"), 4000);
    } catch (e: unknown) {
      setErro(e instanceof Error ? e.message : "Erro"); setStatus("error");
      setTimeout(() => setStatus("idle"), 6000);
    }
  }

  return (
    <div className={cn(
      "flex items-center gap-2 sm:gap-3 px-3 sm:px-4 py-2 sm:py-2.5 border-b border-gray-100 last:border-0 hover:bg-gray-50/80 transition-colors",
      selected && "bg-brand-orange/5"
    )}>
      {phio && <Checkbox checked={selected} onChange={() => onSelect(anx.id, phio, nome)} label="Selecionar arquivo" size="sm" />}
      {!phio && <div className="w-4" />}

      <FileText className={cn("h-4 w-4 flex-shrink-0", circular ? "text-amber-500" : "text-gray-300")} />

      <div className="flex-1 min-w-0">
        <span className="text-sm text-gray-700 truncate block" title={nome}>{nome}</span>
      </div>

      {circular && (
        <span className="hidden sm:inline px-1.5 py-0.5 text-[9px] font-bold uppercase bg-amber-100 text-amber-700 rounded flex-shrink-0">
          Circular
        </span>
      )}

      {anx.tamanhoBytes ? (
        <span className="hidden sm:inline text-[11px] text-gray-400 flex-shrink-0 tabular-nums">
          {anx.tamanhoBytes > 1048576 ? `${(anx.tamanhoBytes / 1048576).toFixed(1)} MB` : `${Math.round(anx.tamanhoBytes / 1024)} KB`}
        </span>
      ) : null}

      {status === "ok" && <span className="text-[11px] text-green-600 font-semibold flex-shrink-0">OK</span>}
      {status === "error" && <span className="text-[11px] text-red-500 flex-shrink-0 truncate max-w-20" title={erro}>{erro}</span>}

      <button onClick={handleDownload} disabled={!phio || status === "downloading"}
        aria-label="Baixar arquivo"
        className={cn("flex-shrink-0 p-1.5 rounded-lg transition-colors",
          !phio ? "text-gray-200 cursor-not-allowed"
          : status === "downloading" ? "text-gray-400"
          : "text-gray-400 hover:text-brand-orange hover:bg-brand-orange/10")}>
        {status === "downloading" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
      </button>
    </div>
  );
}

// ─── Card de licitação (mobile + desktop) ────────────────────────────────────

function LicitacaoCard({ lic, selecionadosArquivos, licSelecionada, onSelectFile, onSelectAllFiles, onToggleLic }: {
  lic: LicitacaoRow;
  selecionadosArquivos: Set<string>;
  licSelecionada: boolean;
  onSelectFile: (id: string, phio: string, filename: string) => void;
  onSelectAllFiles: (licId: string, anexos: Anexo[], select: boolean) => void;
  onToggleLic: (lic: LicitacaoRow) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [anexos, setAnexos] = useState<Anexo[]>([]);
  const [loadingAnexos, setLoadingAnexos] = useState(false);
  const [erro, setErro] = useState("");

  async function toggleExpand() {
    if (!expanded && anexos.length === 0 && lic.totalAnexos > 0) {
      setLoadingAnexos(true); setErro("");
      try {
        const mapa = await fetchAnexosBatch([lic.id]);
        setAnexos(mapa.get(lic.id) ?? []);
      } catch { setErro("Erro ao carregar"); }
      finally { setLoadingAnexos(false); }
    }
    setExpanded((v) => !v);
  }

  const comPhio = useMemo(() => anexos.filter(a => a.phioObjid), [anexos]);
  const totalSel = comPhio.filter((a) => selecionadosArquivos.has(a.id)).length;
  const todosSel = comPhio.length > 0 && totalSel === comPhio.length;

  return (
    <div className={cn(
      "bg-white rounded-xl border transition-all",
      licSelecionada ? "border-brand-orange/40 ring-1 ring-brand-orange/20" : "border-gray-200",
    )}>
      {/* Header do card */}
      <div className="flex items-start gap-3 p-3 sm:p-4">
        <Checkbox checked={licSelecionada} onChange={() => onToggleLic(lic)} label={`Selecionar ${lic.numero}`} />

        <div className="flex-1 min-w-0 cursor-pointer" onClick={toggleExpand}>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-mono text-sm text-brand-orange font-bold">{lic.numero}</span>
            <span className={cn("px-2 py-0.5 rounded-full text-[10px] font-semibold border", relevanciaColor(lic.relevancia))}>
              {lic.relevancia || "-"}
            </span>
            <span className={cn("text-[10px] font-semibold", faseColor(lic.fase))}>
              {lic.fase || "-"}
            </span>
          </div>
          <p className="text-sm text-gray-600 mt-1 line-clamp-2">{lic.objeto || "-"}</p>
          <p className="text-xs text-gray-400 mt-0.5">{lic.empresa || ""}</p>
        </div>

        <div className="flex items-center gap-2 flex-shrink-0">
          {lic.totalAnexos > 0 && (
            <span className="inline-flex items-center gap-1 text-xs font-medium text-gray-500 bg-gray-100 px-2 py-1 rounded-lg">
              <FileDown className="h-3 w-3" /> {lic.totalAnexos}
            </span>
          )}
          {lic.totalAnexos > 0 && (
            <button onClick={toggleExpand} className="p-1 text-gray-400 hover:text-gray-600 transition-colors">
              {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            </button>
          )}
        </div>
      </div>

      {/* Arquivos expandidos */}
      {expanded && (
        <div className="border-t border-gray-100">
          {comPhio.length > 0 && (
            <div className="flex items-center gap-2 px-3 sm:px-4 py-2 bg-gray-50/80 border-b border-gray-100">
              <button onClick={(e) => { e.stopPropagation(); onSelectAllFiles(lic.id, anexos, !todosSel); }}
                className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-brand-orange transition-colors">
                {todosSel ? <CheckCheck className="h-3.5 w-3.5 text-brand-orange" /> : <Square className="h-3.5 w-3.5" />}
                {todosSel ? "Desmarcar" : "Selecionar todos"}
              </button>
              {totalSel > 0 && <span className="text-[11px] text-gray-400">{totalSel} selecionado(s)</span>}
            </div>
          )}

          {loadingAnexos ? (
            <div className="flex items-center justify-center py-8 gap-2 text-gray-400">
              <Loader2 className="h-4 w-4 animate-spin" /> <span className="text-sm">Carregando...</span>
            </div>
          ) : erro ? (
            <div className="flex items-center gap-2 py-4 px-4 text-red-500 text-sm">
              <AlertCircle className="h-4 w-4" /> {erro}
            </div>
          ) : anexos.length === 0 ? (
            <div className="py-6 px-4 text-sm text-gray-400 text-center">Nenhum anexo registrado</div>
          ) : (
            <div>{anexos.map((anx) => (
              <AnexoRow key={anx.id} anx={anx} selected={selecionadosArquivos.has(anx.id)} onSelect={onSelectFile} />
            ))}</div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Página principal ─────────────────────────────────────────────────────────

export default function DownloadsPage() {
  const [licitacoes, setLicitacoes] = useState<LicitacaoRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [relevancia, setRelevancia] = useState("");
  const [soComAnexos, setSoComAnexos] = useState(true);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const [selecionadosArquivos, setSelecionadosArquivos] = useState<Map<string, { phio: string; filename: string }>>(new Map());
  const [licsSelecionadas, setLicsSelecionadas] = useState<Map<string, LicitacaoRow>>(new Map());

  const [zipStatus, setZipStatus] = useState<"idle" | "downloading" | "done" | "error">("idle");
  const [zipProgress, setZipProgress] = useState({ step: "", done: 0, total: 0 });
  const [zipErrors, setZipErrors] = useState<string[]>([]);

  const [bulkStatus, setBulkStatus] = useState<"idle" | "downloading" | "done">("idle");
  const [bulkProgress, setBulkProgress] = useState({ done: 0, total: 0 });
  const [bulkFailed, setBulkFailed] = useState<string[]>([]);

  useEffect(() => { const t = setTimeout(() => setDebouncedSearch(search), 400); return () => clearTimeout(t); }, [search]);

  const fetchLicitacoes = useCallback(async () => {
    setLoading(true); setError(null);
    const params = new URLSearchParams({
      search: debouncedSearch, page: String(page), limit: "25",
      com_anexos: soComAnexos ? "1" : "0", ...(relevancia ? { relevancia } : {}),
    });
    try {
      const res = await fetch(`/api/licitacoes/downloads?${params}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setLicitacoes(json.data ?? []); setTotalPages(json.meta?.pages ?? 1); setTotal(json.meta?.total ?? 0);
    } catch { setError("Erro ao carregar licitações."); setLicitacoes([]); }
    finally { setLoading(false); }
  }, [debouncedSearch, page, soComAnexos, relevancia]);

  useEffect(() => { fetchLicitacoes(); }, [fetchLicitacoes]);
  useEffect(() => { setPage(1); }, [debouncedSearch, relevancia, soComAnexos]);

  function handleSelectFile(id: string, phio: string, filename: string) {
    setSelecionadosArquivos((prev) => { const n = new Map(prev); n.has(id) ? n.delete(id) : n.set(id, { phio, filename }); return n; });
  }
  function handleSelectAllFiles(_: string, anexos: Anexo[], select: boolean) {
    setSelecionadosArquivos((prev) => {
      const n = new Map(prev);
      for (const a of anexos) { if (!a.phioObjid) continue; select ? n.set(a.id, { phio: a.phioObjid, filename: a.descricao || `Arquivo_${a.phioObjid.slice(0,8)}` }) : n.delete(a.id); }
      return n;
    });
  }
  function handleToggleLic(lic: LicitacaoRow) {
    setLicsSelecionadas((prev) => { const n = new Map(prev); n.has(lic.id) ? n.delete(lic.id) : n.set(lic.id, lic); return n; });
  }
  function clearAll() { setSelecionadosArquivos(new Map()); setLicsSelecionadas(new Map()); }

  async function handleBulkDownloadFiles() {
    const items = Array.from(selecionadosArquivos.entries());
    if (!items.length) return;
    setBulkStatus("downloading"); setBulkProgress({ done: 0, total: items.length }); setBulkFailed([]);
    const failed: string[] = [];
    for (let i = 0; i < items.length; i++) {
      const [, { phio, filename }] = items[i];
      const blob = await fetchFileBlob(phio, filename);
      if (blob) { const u = URL.createObjectURL(blob); const a = document.createElement("a"); a.href = u; a.download = filename; document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(u); }
      else { failed.push(filename); }
      setBulkProgress({ done: i + 1, total: items.length });
      if (i < items.length - 1) await new Promise((r) => setTimeout(r, 800));
    }
    setBulkFailed(failed); setBulkStatus("done");
    setTimeout(() => { setBulkStatus("idle"); setSelecionadosArquivos(new Map()); }, failed.length > 0 ? 8000 : 3000);
  }

  async function handleDownloadZip() {
    const lics = Array.from(licsSelecionadas.values());
    if (!lics.length) return;
    setZipStatus("downloading"); setZipErrors([]);
    // Import dinâmico: jszip só entra no bundle quando o usuário gera um ZIP.
    const { default: JSZip } = await import("jszip");
    const zip = new JSZip(); const errors: string[] = [];
    let totalFiles = 0, downloadedFiles = 0;

    setZipProgress({ step: "Listando arquivos...", done: 0, total: lics.length });
    const licData: { lic: LicitacaoRow; anexos: Anexo[] }[] = [];
    // UMA chamada pra todos os anexos (em vez de N requisições /api/licitacoes/[id]).
    try {
      const mapa = await fetchAnexosBatch(lics.map((l) => l.id));
      for (const lic of lics) {
        const a = mapa.get(lic.id) ?? [];
        licData.push({ lic, anexos: a });
        totalFiles += a.filter((x) => x.phioObjid).length;
      }
    } catch {
      errors.push("Erro ao listar arquivos");
    }
    setZipProgress({ step: "Listando arquivos...", done: lics.length, total: lics.length });

    setZipProgress({ step: "Baixando...", done: 0, total: totalFiles });
    for (const { lic, anexos } of licData) {
      const folder = sanitizeName(lic.numero);
      for (const anx of anexos) {
        if (!anx.phioObjid) continue;
        const fn = sanitizeName(anx.descricao || `Arquivo_${anx.phioObjid.slice(0, 8)}`);
        const sub = isCircular(anx.descricao) ? "Circulares" : "Anexos";
        const blob = await fetchFileBlob(anx.phioObjid, fn);
        if (blob) zip.file(`${folder}/${sub}/${fn}`, blob); else errors.push(`${lic.numero}/${sub}/${fn}`);
        downloadedFiles++;
        setZipProgress({ step: `Baixando ${lic.numero}...`, done: downloadedFiles, total: totalFiles });
      }
    }

    setZipProgress({ step: "Gerando ZIP...", done: totalFiles, total: totalFiles });
    try {
      const content = await zip.generateAsync({ type: "blob", compression: "DEFLATE", compressionOptions: { level: 6 } });
      const name = lics.length === 1 ? `${sanitizeName(lics[0].numero)}.zip` : `Licitacoes_${lics.length}.zip`;
      const u = URL.createObjectURL(content); const a = document.createElement("a"); a.href = u; a.download = name; document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(u);
      setZipErrors(errors); setZipStatus("done");
      setTimeout(() => { setZipStatus("idle"); setLicsSelecionadas(new Map()); }, errors.length > 0 ? 8000 : 3000);
    } catch { setZipErrors(["Erro ao gerar ZIP"]); setZipStatus("error"); setTimeout(() => setZipStatus("idle"), 6000); }
  }

  const totalArqSel = selecionadosArquivos.size;
  const totalLicSel = licsSelecionadas.size;
  const licsArray = Array.from(licsSelecionadas.values());
  const selArquivosSet = useMemo(() => new Set(selecionadosArquivos.keys()), [selecionadosArquivos]);

  return (
    <div>
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-brand-black">Downloads</h1>
        <p className="text-sm text-gray-500 mt-1">Selecione licitações para baixar como ZIP organizado ou expanda para arquivos individuais</p>
      </div>

      {/* Painel de licitações selecionadas */}
      {totalLicSel > 0 && (
        <div className="mb-5 rounded-xl border-2 border-brand-orange/30 bg-white overflow-hidden shadow-sm">
          <div className="flex items-center justify-between gap-3 px-4 py-3 bg-gradient-to-r from-brand-orange/5 to-transparent border-b border-brand-orange/10">
            <div className="flex items-center gap-2.5">
              <FolderArchive className="h-5 w-5 text-brand-orange" />
              <span className="text-sm font-bold text-brand-black">
                {totalLicSel} licitação{totalLicSel > 1 ? "ões" : ""} para download
              </span>
            </div>
            <div className="flex items-center gap-2">
              {zipStatus === "done" && zipErrors.length === 0 && <span className="text-xs text-green-600 font-bold">ZIP pronto!</span>}
              <Button onClick={handleDownloadZip} disabled={zipStatus === "downloading"} className="gap-2 shadow-sm">
                {zipStatus === "downloading" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                <span className="hidden sm:inline">Baixar ZIP</span>
              </Button>
              <button onClick={() => setLicsSelecionadas(new Map())} className="p-1.5 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors" aria-label="Limpar seleção">
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          </div>

          <div className="max-h-52 overflow-y-auto divide-y divide-gray-50">
            {licsArray.map((lic) => (
              <div key={lic.id} className="flex items-center gap-3 px-4 py-2 hover:bg-red-50/30 group transition-colors">
                <button onClick={() => handleToggleLic(lic)} aria-label={`Remover ${lic.numero}`}
                  className="flex-shrink-0 p-0.5 rounded text-brand-orange group-hover:text-red-500 transition-colors">
                  <X className="h-4 w-4" />
                </button>
                <span className="font-mono text-sm font-bold text-brand-orange flex-shrink-0">{lic.numero}</span>
                <span className="text-sm text-gray-600 truncate flex-1 min-w-0" title={lic.objeto || ""}>{lic.objeto || "-"}</span>
                <span className={cn("hidden sm:inline px-2 py-0.5 rounded-full text-[10px] font-semibold border flex-shrink-0", relevanciaColor(lic.relevancia))}>
                  {lic.relevancia || "-"}
                </span>
                <span className="text-[11px] text-gray-400 flex-shrink-0 tabular-nums">{lic.totalAnexos} arq.</span>
              </div>
            ))}
          </div>

          {zipStatus === "downloading" && (
            <div className="px-4 py-3 bg-blue-50 border-t border-blue-100">
              <div className="flex items-center justify-between text-sm text-blue-700 mb-1.5">
                <span className="flex items-center gap-2"><Loader2 className="h-3.5 w-3.5 animate-spin" /> {zipProgress.step}</span>
                <span className="text-xs tabular-nums">{zipProgress.done}/{zipProgress.total}</span>
              </div>
              <div className="w-full bg-blue-200 rounded-full h-1.5">
                <div className="bg-blue-600 h-1.5 rounded-full transition-all duration-300" style={{ width: `${zipProgress.total > 0 ? (zipProgress.done / zipProgress.total) * 100 : 0}%` }} />
              </div>
            </div>
          )}

          {zipErrors.length > 0 && (
            <div className="px-4 py-2 bg-amber-50 border-t border-amber-100 text-xs text-amber-700">
              {zipErrors.length} arquivo(s) falharam no download
            </div>
          )}
        </div>
      )}

      {/* Barra de arquivos individuais */}
      {totalArqSel > 0 && totalLicSel === 0 && (
        <div className="mb-5 flex flex-wrap items-center gap-3 bg-gray-900 text-white px-4 py-3 rounded-xl shadow-lg">
          <span className="text-sm font-medium">{totalArqSel} arquivo{totalArqSel > 1 ? "s" : ""}</span>
          {bulkStatus === "downloading" && <span className="text-xs text-gray-400">{bulkProgress.done}/{bulkProgress.total}</span>}
          {bulkStatus === "done" && bulkFailed.length === 0 && <span className="text-xs text-green-400 font-bold">Concluído!</span>}
          <Button size="sm" onClick={handleBulkDownloadFiles} disabled={bulkStatus === "downloading"}>
            {bulkStatus === "downloading" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
            Baixar
          </Button>
          <button onClick={() => setSelecionadosArquivos(new Map())} className="ml-auto text-gray-400 hover:text-white transition-colors"><X className="h-4 w-4" /></button>
        </div>
      )}

      {bulkFailed.length > 0 && (
        <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <p className="font-semibold mb-1">Falhas no download:</p>
          <ul className="list-disc list-inside text-xs text-amber-700">{bulkFailed.map((n, i) => <li key={i}>{n}</li>)}</ul>
        </div>
      )}

      {/* Filtros */}
      <div className="bg-white rounded-xl border border-gray-200 p-3 sm:p-4 mb-5">
        <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 sm:gap-3">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
            <input type="text" value={search} onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar por número ou objeto..." aria-label="Buscar"
              className="w-full pl-10 pr-3 py-2.5 sm:py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-orange/30 focus:border-brand-orange" />
          </div>
          <div className="flex items-center gap-2">
            <select value={relevancia} onChange={(e) => setRelevancia(e.target.value)}
              className="flex-1 sm:flex-none text-sm border border-gray-200 rounded-lg px-3 py-2.5 sm:py-2 text-gray-600 focus:outline-none focus:ring-2 focus:ring-brand-orange/30">
              <option value="">Todas relevâncias</option>
              <option value="ALTA">Alta</option>
              <option value="MÉDIA">Média</option>
              <option value="BAIXA">Baixa</option>
              <option value="SEM INTERESSE">Sem Interesse</option>
            </select>
            <button type="button" role="switch" aria-checked={soComAnexos} aria-label="Só com anexos"
              onClick={() => setSoComAnexos((v) => !v)}
              className={cn("flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium border transition-colors",
                soComAnexos ? "bg-brand-orange/10 border-brand-orange/30 text-brand-orange" : "bg-gray-50 border-gray-200 text-gray-500")}>
              <Filter className="h-3 w-3" /> Só com anexos
            </button>
            {(totalLicSel > 0 || totalArqSel > 0) && (
              <button onClick={clearAll} className="px-3 py-2 rounded-lg text-xs font-medium text-red-500 bg-red-50 border border-red-200 hover:bg-red-100 transition-colors">
                Limpar
              </button>
            )}
          </div>
        </div>
        <div className="mt-2 text-xs text-gray-400">{total} licitação{total !== 1 ? "ões" : ""}</div>
      </div>

      {error && (
        <div className="mb-4 flex items-center justify-between rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          <span>{error}</span>
          <button onClick={fetchLicitacoes} className="rounded-lg bg-red-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-red-700 transition-colors">Tentar novamente</button>
        </div>
      )}

      {/* Lista de licitações (cards) */}
      {loading ? (
        <div className="flex items-center justify-center py-16 gap-2 text-gray-400">
          <Loader2 className="h-5 w-5 animate-spin" /> <span className="text-sm">Carregando licitações...</span>
        </div>
      ) : licitacoes.length === 0 ? (
        <div className="py-16 text-center text-gray-400 text-sm">Nenhuma licitação encontrada com os filtros aplicados.</div>
      ) : (
        <div className="space-y-3">
          {licitacoes.map((lic) => (
            <LicitacaoCard key={lic.id} lic={lic}
              selecionadosArquivos={selArquivosSet}
              licSelecionada={licsSelecionadas.has(lic.id)}
              onSelectFile={handleSelectFile}
              onSelectAllFiles={handleSelectAllFiles}
              onToggleLic={handleToggleLic} />
          ))}
        </div>
      )}

      {/* Paginação */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2 mt-6">
          <button type="button" aria-label="Anterior" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1}
            className="px-4 py-2 text-sm border border-gray-200 rounded-lg disabled:opacity-40 hover:bg-gray-50 transition-colors">← Anterior</button>
          <span className="text-sm text-gray-500 px-2">{page} / {totalPages}</span>
          <button type="button" aria-label="Próxima" onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page === totalPages}
            className="px-4 py-2 text-sm border border-gray-200 rounded-lg disabled:opacity-40 hover:bg-gray-50 transition-colors">Próxima →</button>
        </div>
      )}

      {/* Instruções */}
      <div className="mt-8 bg-gray-50 border border-gray-200 rounded-xl p-4">
        <h3 className="text-xs font-bold text-gray-600 uppercase tracking-wide mb-2">Como usar</h3>
        <ul className="space-y-1.5 text-xs text-gray-500">
          <li>Marque o <strong>checkbox</strong> para selecionar licitações inteiras e baixar como <strong>ZIP organizado</strong></li>
          <li>Cada ZIP contém pastas <strong>Anexos/</strong> e <strong>Circulares/</strong> por licitação</li>
          <li>Clique na <strong>seta</strong> para expandir e baixar arquivos individuais</li>
        </ul>
      </div>
    </div>
  );
}
