import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/__tests__/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    coverage: {
      provider: "v8",
      // Só a lógica pura de src/lib/** conta (rotas/componentes exigiriam
      // harness de integração — medi-los aqui só diluiria o sinal).
      include: ["src/lib/**"],
      // RATCHET (B7): medido em 2026-07-02 = stmts 4.91 / branch 5.27 /
      // funcs 4.42 / lines 4.71 (%). Piso fixado logo abaixo p/ travar
      // regressão SEM quebrar o CI hoje. Ao escrever testes, SUBA os pisos.
      thresholds: {
        statements: 4,
        branches: 4,
        functions: 4,
        lines: 4,
      },
    },
  },
});
