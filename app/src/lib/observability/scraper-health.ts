/**
 * Observabilidade do scraper — consolida a saúde do pipeline de sync.
 *
 * Lê `sync_log` agrupado por tipo (MAX(executado_em), última execução com erros,
 * total encontradas/novas) e calcula o gap em horas vs. o limite esperado por
 * tipo (mesmos limiares do cron sync-monitor). Devolve um snapshot consumível
 * pela rota /api/admin/saude-scraper (dashboard RSC) e pelo próprio sync-monitor.
 *
 * Read-only; nenhum acesso de escrita.
 */

import { db } from "@/db";
import { syncLog } from "@/db/schema";
import { sql, desc } from "drizzle-orm";

/**
 * Limite de horas sem sync por tipo — espelha MAX_HORAS_POR_TIPO do cron
 * sync-monitor (mantido aqui para a consolidação ser autossuficiente).
 * "todas" = 21h: o beat agenda nas janelas 12:00/18:00 UTC (2026-07-07) → gap
 * normal máximo = 18h (18:00 → 12:00 do dia seguinte) + folga de 3h.
 * "petronect_v2" = 36h: pipeline V2 do worker on-prem (cobre falha + retry).
 */
/**
 * Limite de horas sem sync por tipo — FONTE ÚNICA do lado Next.
 *
 * O cron `sync-monitor` importa daqui (antes tinha uma cópia própria, e as duas
 * divergiram: o painel dizia CRÍTICO com um limite e o e-mail com outro).
 *
 * ESPELHOS que precisam ser atualizados JUNTO (Python, não dá para importar):
 *   - bff/app/routers/migrated/admin_saude_scraper.py
 *   - bff/app/routers/migrated/cron_sync_monitor.py
 *
 * Valores de 06/08/2026: ~30% acima da MAIOR janela real do calendário 24/7
 * (descoberta 3x/dia em 09/14/18 UTC). Antes, circulares tolerava 48h para um
 * gap real de 18h — 30h de cegueira.
 */
export const MAX_HORAS_POR_TIPO: Record<string, number> = {
  todas:        18,  // 3 janelas/dia            -> maior gap 15h
  petronect_v2: 20,  // acompanha 'todas' (+5min) -> maior gap 15h
  abertas:      24,
  andamento:    24,
  concluidas:   24,
  resultados:   20,  // 3 janelas/dia            -> maior gap 14h
  circulares:   24,  // completa 11:30 + abertas 18:45 -> maior gap 17h
  transparencia: 30,  // 3 tarefas diarias (09:40/10:00/10:20 UTC) -> gap 24h
  concluidas_historico: 24 * 60,
};

type StatusTipoSync = "OK" | "ATENCAO" | "CRITICO" | "DESCONHECIDO" | "RODANDO";

/**
 * Lock do worker -> tipo do sync_log.
 *
 * As tasks de scraping seguram `lock:worker:scraping:<nome>` no Redis enquanto
 * rodam. O painel lia SO o sync_log, que e escrito no FIM da execucao — entao um
 * job legitimo de 2h30 (circulares completa) aparecia como "16h sem coleta" e
 * pintava a tela de vermelho no meio do trabalho. Ler o lock distingue "rodando
 * agora" de "parado".
 */
const LOCK_PARA_TIPO: Record<string, string> = {
  sync_todas:                     "todas",
  sync_circulares:                "circulares",
  v2_stale:                       "petronect_v2",
  v2_all_db:                      "petronect_v2",
  v2_retry_pending:               "petronect_v2",
  v2_project_resultados:          "resultados",
  transparencia_valores:          "transparencia",
  transparencia_sweep_cnpj:       "transparencia",
  transparencia_sweep_objeto:     "transparencia",
  transparencia_sweep_adjudicacoes: "transparencia",
};

/** Tipos com task de scraping ATIVA agora (lock no Redis). Falha => vazio. */
export async function tiposEmExecucao(): Promise<Set<string>> {
  const url = process.env.CELERY_BROKER_URL ?? process.env.REDIS_URL;
  if (!url) return new Set();
  let cli: import("ioredis").default | null = null;
  try {
    const { default: Redis } = await import("ioredis");
    cli = new Redis(url, { maxRetriesPerRequest: 1, connectTimeout: 1500, lazyConnect: true });
    await cli.connect();
    const chaves = await cli.keys("lock:worker:scraping:*");
    const tipos = new Set<string>();
    for (const k of chaves) {
      const nome = k.split(":").pop() ?? "";
      const tipo = LOCK_PARA_TIPO[nome];
      if (tipo) tipos.add(tipo);
    }
    return tipos;
  } catch {
    return new Set();   // sem Redis o painel volta ao comportamento antigo
  } finally {
    try { await cli?.quit(); } catch { /* ignore */ }
  }
}

interface SaudeTipoSync {
  tipo:           string;
  ultimaExecucao: string | null;   // ISO
  horasDesde:     number | null;
  limiteHoras:    number | null;
  status:         StatusTipoSync;
  erros:          number;
  totalEncontradas: number;
  novas:          number;
  /** Task de scraping ativa agora (lock no Redis). */
  rodando:        boolean;
}

export interface SaudeScraper {
  geradoEm:       string;           // ISO
  tipos:          SaudeTipoSync[];
  /** Pior status agregado entre todos os tipos conhecidos. */
  statusGlobal:   StatusTipoSync;
  /** Tipos em gap excedido (CRITICO). */
  tiposCriticos:  string[];
  ultimoLogId:    number | null;
  ultimoLogEm:    string | null;
}

function classifica(
  horasDesde: number | null,
  limite: number | null,
  erros: number,
  rodando = false,
): StatusTipoSync {
  // Rodando agora nao e atraso: o sync_log so recebe a linha quando termina.
  if (rodando) return "RODANDO";
  if (limite == null || horasDesde == null) return "DESCONHECIDO";
  if (horasDesde >= limite) return "CRITICO";
  if (erros > 0) return "ATENCAO";
  // Aviso quando passou de 75% do limite sem novo sync.
  if (horasDesde >= limite * 0.75) return "ATENCAO";
  return "OK";
}

const RANK: Record<StatusTipoSync, number> = { OK: 0, RODANDO: 0, DESCONHECIDO: 1, ATENCAO: 2, CRITICO: 3 };

/**
 * Monta o snapshot de saúde do scraper a partir de sync_log.
 */
export async function getSaudeScraper(): Promise<SaudeScraper> {
  const agora = new Date();
  const emExecucao = await tiposEmExecucao();

  // Última execução + métricas por tipo. Usamos DISTINCT ON para pegar a métrica
  // do último log de cada tipo (erros/novas/total da execução mais recente).
  const ultimosPorTipo = await db.execute(sql`
    SELECT DISTINCT ON (tipo)
      tipo,
      executado_em,
      COALESCE(erros, 0)             AS erros,
      COALESCE(total_encontradas, 0) AS total_encontradas,
      COALESCE(novas, 0)             AS novas
    FROM sync_log
    ORDER BY tipo, executado_em DESC NULLS LAST
  `);

  type Row = {
    tipo: string; executado_em: Date | string | null;
    erros: number; total_encontradas: number; novas: number;
  };
  const rows = ultimosPorTipo.rows as unknown as Row[];

  const tipos: SaudeTipoSync[] = rows.map((r) => {
    const ultima = r.executado_em ? new Date(r.executado_em) : null;
    const horasDesde = ultima
      ? Math.floor((agora.getTime() - ultima.getTime()) / (1000 * 60 * 60))
      : null;
    const limite = MAX_HORAS_POR_TIPO[r.tipo] ?? null;
    return {
      tipo:             r.tipo,
      ultimaExecucao:   ultima ? ultima.toISOString() : null,
      horasDesde,
      limiteHoras:      limite,
      status:           classifica(horasDesde, limite, Number(r.erros) || 0, emExecucao.has(r.tipo)),
      rodando:          emExecucao.has(r.tipo),
      erros:            Number(r.erros) || 0,
      totalEncontradas: Number(r.total_encontradas) || 0,
      novas:            Number(r.novas) || 0,
    };
  });

  // Ordena: piores primeiro, depois por tipo
  tipos.sort((a, b) => RANK[b.status] - RANK[a.status] || a.tipo.localeCompare(b.tipo));

  const statusGlobal = tipos.reduce<StatusTipoSync>(
    (pior, t) => (RANK[t.status] > RANK[pior] ? t.status : pior),
    "OK",
  );
  const tiposCriticos = tipos.filter((t) => t.status === "CRITICO").map((t) => t.tipo);

  // Último log global (id + timestamp) para correlação/log.
  const [ultimo] = await db
    .select({ id: syncLog.id, executadoEm: syncLog.executadoEm })
    .from(syncLog)
    .orderBy(desc(syncLog.executadoEm))
    .limit(1);

  return {
    geradoEm:     agora.toISOString(),
    tipos,
    statusGlobal,
    tiposCriticos,
    ultimoLogId:  ultimo?.id ?? null,
    ultimoLogEm:  ultimo?.executadoEm ? new Date(ultimo.executadoEm).toISOString() : null,
  };
}

/** Indica se o snapshot exige alerta (gap crítico ou erros). */
function precisaAlertar(saude: SaudeScraper): boolean {
  return saude.statusGlobal === "CRITICO" || saude.tipos.some((t) => t.erros > 0);
}
