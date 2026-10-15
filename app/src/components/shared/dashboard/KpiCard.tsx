"use client";

import { cn } from "@/lib/utils";
import Link from "next/link";
import { ArrowUpRight, ArrowDownRight, Minus } from "lucide-react";

interface KpiCardProps {
  label: string;
  value: number;
  sparkData?: { v: number }[];
  trend?: string;
  trendUp?: boolean;
  color?: "default" | "orange" | "green" | "amber" | "red";
  href?: string;
}

const SPARK_COLORS = {
  default: { stroke: "#d1d5db", fill: "#f9fafb", bg: "" },
  orange:  { stroke: "#fb923c", fill: "#fff7ed", bg: "border-orange-100" },
  green:   { stroke: "#4ade80", fill: "#f0fdf4", bg: "border-green-100" },
  amber:   { stroke: "#fbbf24", fill: "#fffbeb", bg: "border-amber-100" },
  red:     { stroke: "#f87171", fill: "#fef2f2", bg: "border-red-100" },
};

/**
 * Sparkline decorativa em SVG puro (sem recharts): polyline com pontos
 * normalizados 0..100 esticada no container, sem eixos nem tooltip.
 * `preserveAspectRatio="none"` reproduz o ResponsiveContainer; o
 * vector-effect mantém o traço com 2px independente da escala.
 */
function Sparkline({ data, stroke, gradientId }: {
  data: { v: number }[];
  stroke: string;
  gradientId: string;
}) {
  const W = 100, H = 100, TOP = 6; // TOP ≈ margem superior de 4px do gráfico original
  const values = data.map((d) => d.v);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min;
  const points = values
    .map((v, i) => {
      const x = (i / (values.length - 1)) * W;
      const y = range === 0 ? H / 2 : TOP + (1 - (v - min) / range) * (H - TOP);
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      className="w-full h-full"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={stroke} stopOpacity={0.3} />
          <stop offset="100%" stopColor={stroke} stopOpacity={0.05} />
        </linearGradient>
      </defs>
      <polygon points={`${points} ${W},${H} 0,${H}`} fill={`url(#${gradientId})`} />
      <polyline
        points={points}
        fill="none"
        stroke={stroke}
        strokeWidth={2}
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

export function KpiCard({ label, value, sparkData, trend, trendUp, color = "default", href }: KpiCardProps) {
  const colors = SPARK_COLORS[color];

  const TrendIcon = trendUp === true ? ArrowUpRight : trendUp === false ? ArrowDownRight : Minus;

  const content = (
    <div className={cn(
      "relative overflow-hidden rounded-2xl border bg-white p-5 transition-all group",
      colors.bg || "border-gray-100",
      href && "hover:shadow-lg hover:-translate-y-0.5 cursor-pointer",
    )}>
      {/* Sparkline background */}
      {sparkData && sparkData.length > 1 && (
        <div className="absolute inset-x-0 bottom-0 h-16 opacity-30 group-hover:opacity-50 transition-opacity">
          <Sparkline data={sparkData} stroke={colors.stroke} gradientId={`grad-${color}`} />
        </div>
      )}

      <div className="relative z-10">
        <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider">{label}</p>
        <div className="flex items-end gap-2 mt-1.5">
          <p className="text-4xl font-extrabold text-gray-900 tabular-nums leading-none">{value.toLocaleString("pt-BR")}</p>
          {trend && (
            <div className={cn(
              "flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[10px] font-bold mb-1",
              trendUp === true ? "bg-green-50 text-green-700"
                : trendUp === false ? "bg-red-50 text-red-600"
                : "bg-gray-50 text-gray-500"
            )}>
              <TrendIcon className="h-3 w-3" />
              {trend}
            </div>
          )}
        </div>
      </div>
    </div>
  );

  return href ? <Link href={href}>{content}</Link> : content;
}
