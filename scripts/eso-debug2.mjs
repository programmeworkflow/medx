// Acha companyId de uma empresa REAL com workers e captura a resposta full
import { chromium } from "playwright";
const URL_LOGIN = "https://core.sistemaeso.com.br/license/lobby";
const EMAIL = "medwork.financeiro@gmail.com";
const PASS = "medWORK123*";
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext();
const page = await ctx.newPage();
await page.goto(URL_LOGIN, { waitUntil: "domcontentloaded" });
const f = await page.evaluate(() => [...document.querySelectorAll("input")].find(i => /mail|user/i.test(i.name||""))?.name);
await page.fill(`input[name="${f}"]`, EMAIL);
await page.fill('input[type="password"]', PASS);
await page.click('button[type="submit"]');
await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});

// List companies pages until we find CNPJ 15398344000178
const target = "15398344000178";
let companyId = null;
for (let pg = 1; pg <= 30 && !companyId; pg++) {
  const j = await page.evaluate(async (p) => {
    const body = new URLSearchParams({
      personGroup: "Company", page: String(p),
      searchEsocial: "0", searchA1Certificate: "0-true", searchFuncionarios: "all",
    });
    const r = await fetch("/api/core/personcompanyformainlisting", {
      method: "POST", body: body.toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Requested-With": "XMLHttpRequest" },
      credentials: "include",
    });
    return await r.json();
  }, pg);
  for (const c of j.Content || []) {
    if (c.DocumentNumber === target) {
      companyId = c.Id;
      console.log(`Found: page ${pg} → Id ${companyId} ${c.Name}`);
      break;
    }
  }
}
if (!companyId) { console.log("not found"); process.exit(); }

const w = await page.evaluate(async (cid) => {
  const body = new URLSearchParams({ page: "1", orderBy: "workername" });
  const r = await fetch(`/api/core/workersformainlisting?companyid=${cid}`, {
    method: "POST", body: body.toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Requested-With": "XMLHttpRequest" },
    credentials: "include",
  });
  return await r.text();
}, companyId);
console.log("=== WORKERS RESPONSE ===");
console.log(w.slice(0, 4000));
await browser.close();
