import type { NextConfig } from "next";

// ── Security Headers ─────────────────────────────────────────────────────────

const securityHeaders = [
  // Impede que o browser "adivinhe" o tipo MIME — evita sniffing attacks
  { key: "X-Content-Type-Options", value: "nosniff" },

  // Petro Radar é uma app interna — bloqueia totalmente embedding em iframe
  { key: "X-Frame-Options", value: "DENY" },

  // Controla informações de referer enviadas a terceiros
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },

  // OWASP recomenda 0: o filtro XSS legado do browser tem bypasses conhecidos
  { key: "X-XSS-Protection", value: "0" },

  // HSTS (Strict-Transport-Security) foi MOVIDO para o NGINX (borda TLS) no on-prem.
  // Aqui no app NÃO o emitimos: a app é servida em HTTP atrás do NGINX (TLS termina
  // no NGINX) e, em dev/acesso direto via http://localhost:3000, o HSTS + o
  // upgrade-insecure-requests quebrariam o carregamento de assets (ERR_SSL).
  // Ver nginx/conf.d/petro-radar.conf.

  // Prefetch de DNS apenas para domínios do próprio site
  { key: "X-DNS-Prefetch-Control", value: "on" },

  // Restringe uso de features sensíveis do browser
  {
    key: "Permissions-Policy",
    value: [
      "camera=()",
      "microphone=()",
      "geolocation=()",
      "interest-cohort=()",
    ].join(", "),
  },

  // Content Security Policy
  // script-src (G8, endurecido 2026-07-02):
  //   • 'unsafe-eval' SÓ em desenvolvimento — o HMR/react-refresh do `next dev`
  //     usa eval(); o bundle de PRODUÇÃO do Next 15 não precisa (build validado
  //     sem ele). Mantê-lo em prod anularia a principal proteção anti-XSS.
  //   • 'unsafe-inline' MANTIDO (TODO nonce): o Next injeta inline scripts de
  //     hidratação RSC; removê-los sem nonce quebra a app. Nonce por request
  //     exige middleware (gerar nonce + repassar via header p/ o App Router) —
  //     invasivo demais nesta onda. Estratégia de medição futura: acrescentar
  //     um header Content-Security-Policy-Report-Only mais estrito (sem
  //     'unsafe-inline', com report-uri para um endpoint de coleta) e observar
  //     os relatórios em produção ANTES do enforce — sem risco de quebra.
  // Storage (R2) é acessado server-side via proxy autenticado — browser nunca conecta direto.
  // Anthropic/SMTP também são chamados server-side; não precisam estar em connect-src.
  {
    key: "Content-Security-Policy",
    value: [
      "default-src 'self'",
      process.env.NODE_ENV === "development"
        ? "script-src 'self' 'unsafe-eval' 'unsafe-inline'"
        : "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      "connect-src 'self'",
      "media-src 'none'",
      // 'self' (era 'none'): a prévia de PDF do cofre embute o próprio download em
      // <object> — com 'none' ela nunca pintava (achado M4, auditoria 2026-08-05).
      // Só a própria origem; nada externo.
      "object-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      // PWA: o manifest (/manifest.webmanifest) e o /sw.js de despedida (se
      // desregistra; o push saiu em 2026-09) são servidos same-origin.
      "worker-src 'self'",
      "manifest-src 'self'",
      // 'upgrade-insecure-requests' REMOVIDO: forçava os assets para https://,
      // quebrando o app servido em HTTP (dev direto e atrás do NGINX que termina
      // TLS). O NGINX adiciona esse diretivo no on-prem (resposta HTTPS).
    ].join("; "),
  },
];

// ── Next.js Config ───────────────────────────────────────────────────────────

const nextConfig: NextConfig = {
  // Empacota um servidor Node mínimo com deps já tracejadas (inclui sharp) em
  // .next/standalone — base da imagem on-prem offline (Dockerfile.web copia esse
  // diretório). Sem isto, o `next build` não gera .next/standalone/server.js.
  output: "standalone",

  experimental: {
    serverActions: {
      bodySizeLimit: "10mb",
    },
    // Tree-shaking de imports nomeados em libs com muitos ícones/componentes —
    // reduz o bundle (lucide-react e recharts são os maiores ofensores aqui).
    optimizePackageImports: ["lucide-react", "recharts"],
  },

  async headers() {
    return [
      {
        // Aplica security headers em todas as rotas
        source: "/(.*)",
        headers: securityHeaders,
      },
      {
        // Download do cofre (achado M4): a resposta é um ARQUIVO, não uma página —
        // só a diretiva de emolduramento faz sentido nela. Depois da global de
        // propósito: o Next aplica a última chave repetida, e aqui SAMEORIGIN /
        // frame-ancestors 'self' substituem o DENY / 'none' para o <object> da
        // prévia (mesma origem) poder carregar o PDF.
        source: "/api/conformidade/cofre/documentos/:id/download",
        headers: [
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          { key: "Content-Security-Policy", value: "frame-ancestors 'self'" },
        ],
      },
      {
        // O /sw.js NUNCA deve ser cacheado: é assim que os navegadores que
        // registraram o SW antigo (Web Push, removido em 2026-09) buscam a versão
        // de despedida, que se desregistra.
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Service-Worker-Allowed", value: "/" },
        ],
      },
    ];
  },

  async redirects() {
    return [
      // Habilitação foi consolidada dentro do Acervo Técnico.
      // Mantemos redirects permanentes para bookmarks e links externos.
      { source: "/habilitacao",                      destination: "/acervo/cofre",                  permanent: true },
      { source: "/habilitacao/biblioteca",           destination: "/acervo/cofre",                  permanent: true },
      { source: "/habilitacao/biblioteca/novo",      destination: "/acervo/cofre/novo",             permanent: true },
      { source: "/habilitacao/biblioteca/:id",       destination: "/acervo/cofre/:id",              permanent: true },
      // Famílias CRC saíram da raiz e vivem dentro do Acervo Técnico.
      { source: "/familias",                         destination: "/acervo/familias",               permanent: true },
      { source: "/familias/nova",                    destination: "/acervo/familias/nova",          permanent: true },
      { source: "/familias/:id",                     destination: "/acervo/familias/:id",           permanent: true },
      // Conformidade → Acervo: o módulo foi reduzido a Cofre, Famílias CRC e
      // Busca Semântica. O dashboard raiz (antigo painel SGI /acervo/habilitacao)
      // foi removido, então /conformidade cai no Cofre — a tela mais usada.
      // O genérico /conformidade/:path* segue mapeando cofre/familias; matriz,
      // envelopes, contratos e importar passam a 404 (removidos da UI por design).
      // As APIs continuam em /api/conformidade/*.
      { source: "/conformidade",                     destination: "/acervo/cofre",                  permanent: true },
      { source: "/conformidade/:path*",              destination: "/acervo/:path*",                 permanent: true },
      // Singular → plural após modularização do domínio Licitações.
      { source: "/licitacao/:id",                    destination: "/licitacoes/:id",                permanent: true },
    ];
  },

  async rewrites() {
    return [
      // Back-compat de APIs após renomear /api/habilitacao/*, /api/familias/*
      // e /api/import/* para dentro de /api/conformidade/*. Rewrites (não redirects)
      // mantêm CLI petro-radar-sync, scripts de integração e tokens existentes
      // funcionando sem mudança no client.
      { source: "/api/habilitacao/documentos",            destination: "/api/conformidade/cofre/documentos" },
      { source: "/api/habilitacao/documentos/:path*",     destination: "/api/conformidade/cofre/documentos/:path*" },
      { source: "/api/familias",                          destination: "/api/conformidade/familias" },
      { source: "/api/familias/:path*",                   destination: "/api/conformidade/familias/:path*" },
      { source: "/api/import",                            destination: "/api/conformidade/import" },
      { source: "/api/import/:path*",                     destination: "/api/conformidade/import/:path*" },
      // APIs órfãs reagrupadas no domínio Licitações + audit no domínio Admin.
      { source: "/api/search",                            destination: "/api/licitacoes/search" },
      { source: "/api/reclassify",                        destination: "/api/licitacoes/reclassify" },
      { source: "/api/audit-log",                         destination: "/api/admin/audit-log" },
    ];
  },
};

export default nextConfig;
