// Explora o ESO logando, tirando screenshots dos menus e capturando network requests
// para identificar APIs internas que listam empresas e funcionários.
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const URL_LOGIN = "https://core.sistemaeso.com.br/license/lobby";
const EMAIL = "medwork.financeiro@gmail.com";
const PASS = "medWORK123*";
const OUT = "/tmp/eso-explore";

fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const page = await ctx.newPage();

const requests = [];
page.on("requestfinished", async (req) => {
  try {
    const url = req.url();
    const method = req.method();
    const res = await req.response();
    const status = res?.status();
    const ct = res?.headers()["content-type"] || "";
    if (
      method === "GET" &&
      (ct.includes("json") || url.includes("api") || url.includes("empresa") || url.includes("funcionario") || url.includes("trabalhador"))
    ) {
      requests.push({ url, method, status, ct });
    }
  } catch (_) {}
});

console.log("→ open login");
await page.goto(URL_LOGIN, { waitUntil: "domcontentloaded", timeout: 30000 });
await page.screenshot({ path: path.join(OUT, "01-login.png"), fullPage: true });
console.log("title:", await page.title(), "url:", page.url());

// Try common selectors
await page.fill('input[type="email"], input[name="email"], input[placeholder*="mail" i]', EMAIL).catch(() => {});
await page.fill('input[type="password"], input[name="password"], input[placeholder*="senha" i]', PASS).catch(() => {});
await page.screenshot({ path: path.join(OUT, "02-filled.png"), fullPage: true });

// Try button submit
const btn = page.locator('button:has-text("Entrar"), button:has-text("Login"), button[type="submit"]').first();
await btn.click().catch(() => {});
await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
await page.waitForTimeout(2000);
await page.screenshot({ path: path.join(OUT, "03-after-login.png"), fullPage: true });
console.log("after-login url:", page.url());

// Save the post-login HTML
fs.writeFileSync(path.join(OUT, "post-login.html"), await page.content());

// Try to discover menus / nav items
const navTexts = await page.evaluate(() => {
  const found = new Set();
  document.querySelectorAll("a, button, [role='menuitem'], li").forEach((el) => {
    const t = (el.textContent || "").trim();
    const href = el.getAttribute("href") || "";
    if (t.length > 1 && t.length < 60) found.add(`${t}\t${href}`);
  });
  return [...found];
});
fs.writeFileSync(path.join(OUT, "nav.txt"), navTexts.join("\n"));
console.log("nav items captured:", navTexts.length);

// Look for "empresa" / "funcionario" / "cadastro" links
const candidates = navTexts.filter((s) =>
  /empresa|funcion|trabal|colab|cadastro|relator|cliente/i.test(s)
);
console.log("candidates:");
candidates.slice(0, 30).forEach((c) => console.log("  ", c));

// List all visited URLs with API potential
console.log("\nAPI-ish requests captured:", requests.length);
requests.slice(0, 20).forEach((r) => console.log(`  ${r.status} ${r.method} ${r.url}`));

fs.writeFileSync(path.join(OUT, "requests.json"), JSON.stringify(requests, null, 2));

await browser.close();
console.log("\n→ artifacts in", OUT);
