import Link from "next/link";
import { cn } from "@/lib/utils";
import { FileText, ArrowRightLeft, AlertCircle, Zap, Activity } from "lucide-react";

interface FeedItem {
  id: string;
  type: "nova" | "fase" | "circular" | "resultado" | "sync";
  title: string;
  detail?: string;
  link?: string;
  timestamp: string | null;
}

interface ActivityFeedProps {
  items: FeedItem[];
}

const ICONS = {
  nova:      { icon: Zap,            color: "text-green-600 bg-green-100" },
  fase:      { icon: ArrowRightLeft, color: "text-blue-600 bg-blue-100" },
  circular:  { icon: FileText,       color: "text-amber-600 bg-amber-100" },
  resultado: { icon: AlertCircle,    color: "text-violet-600 bg-violet-100" },
  sync:      { icon: Activity,       color: "text-gray-500 bg-gray-100" },
};

function formatRelTime(ts: string | null): string {
  if (!ts) return "";
  const diff = Date.now() - new Date(ts).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "agora";
  if (mins < 60) return `${mins}min`;
  const hrs = Math.floor(diff / 3600000);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.floor(diff / 86400000);
  if (days === 1) return "ontem";
  return `${days}d`;
}

export function ActivityFeed({ items }: ActivityFeedProps) {
  return (
    <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden">
      <div className="flex items-center gap-2.5 px-5 py-3.5 border-b border-gray-100 bg-gradient-to-r from-gray-50/80 to-transparent">
        <div className="w-7 h-7 rounded-lg bg-gray-100 flex items-center justify-center">
          <Activity className="h-3.5 w-3.5 text-gray-500" />
        </div>
        <div>
          <h2 className="text-sm font-bold text-gray-900">Atividade Recente</h2>
          <p className="text-[10px] text-gray-400">Últimos 7 dias</p>
        </div>
      </div>

      <div className="divide-y divide-gray-50 max-h-60 overflow-y-auto">
        {items.length === 0 ? (
          <div className="py-10 text-center">
            <Activity className="h-8 w-8 text-gray-200 mx-auto mb-2" />
            <p className="text-sm text-gray-400">Nenhuma atividade recente</p>
          </div>
        ) : (
          items.map((item) => {
            const cfg = ICONS[item.type];
            const Icon = cfg.icon;
            const inner = (
              <div className="flex items-start gap-3 px-5 py-3 hover:bg-gray-50/70 transition-colors group">
                <div className={cn("flex-shrink-0 mt-0.5 w-8 h-8 rounded-lg flex items-center justify-center", cfg.color)}>
                  <Icon className="h-4 w-4" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-gray-700 group-hover:text-gray-900 transition-colors">{item.title}</p>
                  {item.detail && <p className="text-xs text-gray-400 truncate mt-0.5">{item.detail}</p>}
                </div>
                <span className="text-[11px] text-gray-400 flex-shrink-0 tabular-nums mt-0.5 font-medium">{formatRelTime(item.timestamp)}</span>
              </div>
            );
            return item.link ? (
              <Link key={item.id} href={item.link} className="block">{inner}</Link>
            ) : (
              <div key={item.id}>{inner}</div>
            );
          })
        )}
      </div>
    </div>
  );
}
