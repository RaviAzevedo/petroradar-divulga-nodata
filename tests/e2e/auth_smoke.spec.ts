/**
 * F9 — Fumaça de UI: login → painel → detalhe de licitação (Playwright).
 *
 * Pré-requisitos: stack viva (make up), seed e2e aplicado, WEB_BASE_URL apontando
 * para o Next (default http://localhost:3000). Credenciais via env (mesmas do
 * harness API): E2E_ADMIN_EMAIL / E2E_ADMIN_PASSWORD.
 */
import { test, expect } from "@playwright/test";

const EMAIL = process.env.E2E_ADMIN_EMAIL ?? "admin@example.local";
const PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? "changeme-admin";
const LICITACAO_ID =
  process.env.E2E_LICITACAO_ID ?? "00000000-0000-4000-8000-000000000101";

test.describe("Fumaça UI — auth e navegação", () => {
  test("login → painel → detalhe licitação", async ({ page }) => {
    await page.goto("/login");
    await expect(page.getByRole("heading", { name: /entrar na plataforma/i })).toBeVisible();

    await page.getByLabel(/email/i).fill(EMAIL);
    await page.getByLabel(/^senha$/i).fill(PASSWORD);
    await page.getByRole("button", { name: /^entrar$/i }).click();

    // Pós-login: desktop → / ; mobile → /hoje (viewport default = desktop).
    await page.waitForURL(/\/(hoje)?$/, { timeout: 30_000 });

    // Painel ou Hoje deve renderizar shell autenticado (sidebar/nav).
    await expect(page.locator("nav, aside").first()).toBeVisible({ timeout: 15_000 });

    await page.goto(`/licitacoes/${LICITACAO_ID}`);
    await expect(page.getByRole("heading").first()).toBeVisible({ timeout: 15_000 });
    // Não deve cair em /sem-acesso nem /login.
    await expect(page).not.toHaveURL(/\/(login|sem-acesso)/);
  });
});
