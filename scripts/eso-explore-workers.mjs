// Explora a tela de workers numa empresa REAL pra capturar params completos
import { chromium } from "playwright";
import fs from "node:fs";

const URL_LOGIN = "https://core.sistemaeso.com.br/license/lobby";
const EMAIL = "medwork.financeiro@gmail.com";
const PASS = "medWORK123*";
const TARGET_CNPJ = "46211521000199"; // 2M Dentallab — empresa piloto que o user passou

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const page = await ctx.newPage();

const calls = [];
page.on("requestfinished", async (req) => {
  const url = req.url();
  if (url.includes("workers") || url.includes("/api/core/")) {
    try {
      const res = await req.response();
      const body = await res?.text().catch(() => "");
      calls.push({
        method: req.method(),
        url,
        body: req.postData(),
        status: res?.status(),
        respLen: body?.length,
        respSample: (body || "").slice(0, 1500),
      });
    } catch (_) {}
  }
});

console.log("→ login");
await page.goto(URL_LOGIN, { waitUntil: "domcontentloaded" });
const emailField = await page.evaluate(() => {
  const inp = [...document.querySelectorAll("input")].find((i) => /mail|user/i.test(i.name || ""));
  return inp?.name;
});
await page.fill(`input[name="${emailField}"]`, EMAIL);
await page.fill('input[type="password"]', PASS);
await page.click('button[type="submit"]');
await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});

// Find company by CNPJ
console.log(`→ search empresa CNPJ ${TARGET_CNPJ}`);
await page.goto("https://core.sistemaeso.com.br/company/companies", { waitUntil: "networkidle", timeout: 30000 }).catch(() => {});
await page.waitForTimeout(2000);

// Search via API to find ID
const searchResult = await page.evaluate(async (cnpj) => {
  const body = new URLSearchParams({
    personGroup: "Company",
    page: "1",
    searchEsocial: "0",
    searchA1Certificate: "0-true",
    searchFuncionarios: "all",
    searchString: cnpj,
  });
  const r = await fetch("/api/core/personcompanyformainlisting", {
    method: "POST",
    body: body.toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Requested-With": "XMLHttpRequest" },
    credentials: "include",
  });
  return await r.text();
}, TARGET_CNPJ);
console.log("search result:", searchResult.slice(0, 500));
const m = searchResult.match(/"Id":(\d+),"Name":"[^"]*","SocialName":"[^"]*","Email":"[^"]*","PhoneAndAreaCode":"[^"]*","ParentPersonName":"[^"]*","IsESocialEnabled":[^,]+,"IsEmailEnabled":[^,]+,"IsUnableToReceiveEmails":[^,]+,"IsEmployer":true[^}]*"DocumentNumber":"46211521000199"/);
if (m) console.log("found Id:", m[1]);

// Visit workers planning of any company
console.log("\n→ visit workers planning page (qualquer empresa com workers)");
// Try a known company with workers from our exploration
await page.goto("https://core.sistemaeso.com.br/company/workersplanning?companyid=13002555", { waitUntil: "networkidle", timeout: 30000 }).catch(() => {});
await page.waitForTimeout(4000);

console.log("\nCalls capturadas:");
calls.forEach((c) => {
  console.log(`${c.status} ${c.method} ${c.url}`);
  if (c.body) console.log(`  body: ${c.body.slice(0, 300)}`);
  if (c.respLen) console.log(`  resp: ${c.respLen}B  sample: ${(c.respSample || "").replace(/\n/g, " ").slice(0, 200)}`);
});

fs.writeFileSync("/tmp/eso-explore/workers-calls.json", JSON.stringify(calls, null, 2));
await browser.close();
