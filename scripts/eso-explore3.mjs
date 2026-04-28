// V3 — login mais robusto + storageState + exploração
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

const apiLogs = [];
ctx.on("request", (req) => {
  const url = req.url();
  if (url.includes("sistemaeso.com.br/api/")) {
    apiLogs.push({ t: "REQ", method: req.method(), url, body: req.postData()?.slice(0, 600) });
  }
});
ctx.on("response", async (res) => {
  const url = res.url();
  if (!url.includes("sistemaeso.com.br/api/")) return;
  try {
    apiLogs.push({ t: "RES", url, status: res.status(), ct: res.headers()["content-type"] });
  } catch (_) {}
});

console.log("→ login");
await page.goto(URL_LOGIN, { waitUntil: "domcontentloaded" });
console.log("redirected to:", page.url());
// the page now is /account/login
await page.waitForSelector('input[name*="mail" i], input[name*="user" i], input[type="email"], input[placeholder*="mail" i], input[placeholder*="login" i]', { timeout: 20000 });
const emailSel = await page.evaluate(() => {
  const inputs = [...document.querySelectorAll("input")];
  const found = inputs.find((i) =>
    /mail|user|login/i.test(i.name || "") || /mail|usuário|usuario|login/i.test(i.placeholder || "") || i.type === "email"
  );
  return found ? found.name || found.placeholder || found.id : null;
});
console.log("email field:", emailSel);
await page.fill(`input[name="${emailSel}"]`, EMAIL);
await page.fill('input[type="password"]', PASS);
await page.click('button[type="submit"], input[type="submit"]');
await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
await page.waitForTimeout(2000);
console.log("post-login url:", page.url());
await ctx.storageState({ path: path.join(OUT, "storage-state.json") });

// 1. List companies
console.log("\n→ /company/companies");
await page.goto("https://core.sistemaeso.com.br/company/companies?page=1", { waitUntil: "networkidle", timeout: 30000 }).catch(() => {});
await page.screenshot({ path: path.join(OUT, "20-empresas.png"), fullPage: true });
fs.writeFileSync(path.join(OUT, "empresas.html"), await page.content());

// Try several common API patterns
const apiTries = [
  "/api/v3/company/companies?page=1",
  "/api/v3/companies?page=1",
  "/api/v3/companies/list",
  "/api/v3/company",
  "/api/v3/people",
  "/api/v3/employees",
  "/api/v3/persons",
  "/company/api/companies",
  "/api/v3/company/companies/list?page=1",
];
const apiResults = {};
for (const ep of apiTries) {
  try {
    const r = await page.evaluate(async (url) => {
      const res = await fetch(url, { credentials: "include" });
      const txt = await res.text();
      return { status: res.status, len: txt.length, sample: txt.slice(0, 500) };
    }, "https://core.sistemaeso.com.br" + ep);
    apiResults[ep] = r;
    console.log(`API ${ep} → ${r.status} ${r.len}B`);
    if (r.status === 200 && r.len > 100) console.log("    sample:", r.sample.slice(0, 200));
  } catch (_) {}
}
fs.writeFileSync(path.join(OUT, "api-tries.json"), JSON.stringify(apiResults, null, 2));

// Look for "person" / "funcionário" submenu by parsing all internal links
const links = await page.evaluate(() =>
  [...document.querySelectorAll("a[href]")]
    .map((a) => ({ text: (a.textContent || "").trim(), href: a.getAttribute("href") }))
    .filter((l) => l.href && l.href.startsWith("/"))
);
const interesting = links.filter((l) =>
  /pessoa|person|funcion|traba|colab|empresa|cnpj|cpf|export|relator|cadastr/i.test(
    l.href + " " + l.text
  )
);
console.log("\n→ interesting links:");
const dedup = {};
for (const l of interesting) dedup[l.href] = l.text;
Object.entries(dedup).forEach(([href, text]) => console.log(`  ${href}\t${text}`));
fs.writeFileSync(path.join(OUT, "links-interesting.json"), JSON.stringify(dedup, null, 2));

// API logs sumário
console.log("\nAPI calls observed:", apiLogs.filter((l) => l.t === "RES").length);
const dedupApi = new Set(apiLogs.filter((l) => l.t === "RES").map((l) => l.url));
[...dedupApi].slice(0, 30).forEach((u) => console.log("  ", u));
fs.writeFileSync(path.join(OUT, "api-logs.json"), JSON.stringify(apiLogs, null, 2));

await browser.close();
console.log("\n→ saved to", OUT);
