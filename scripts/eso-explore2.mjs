// Explora menus em profundidade: /company/companies + listagem funcionários
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const URL_LOGIN = "https://core.sistemaeso.com.br/account/login";
const EMAIL = "medwork.financeiro@gmail.com";
const PASS = "medWORK123*";
const OUT = "/tmp/eso-explore";
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const page = await ctx.newPage();

const apiLogs = [];
page.on("requestfinished", async (req) => {
  try {
    const url = req.url();
    if (!url.includes("sistemaeso.com.br/api/")) return;
    const res = await req.response();
    if (!res) return;
    apiLogs.push({
      method: req.method(),
      url,
      status: res.status(),
      ct: res.headers()["content-type"],
    });
  } catch (_) {}
});

console.log("→ login");
await page.goto(URL_LOGIN, { waitUntil: "domcontentloaded" });
await page.fill('input[type="email"]', EMAIL);
await page.fill('input[type="password"]', PASS);
await page.click('button[type="submit"]');
await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});

console.log("→ /company/companies");
await page.goto("https://core.sistemaeso.com.br/company/companies", { waitUntil: "networkidle", timeout: 30000 }).catch(() => {});
await page.screenshot({ path: path.join(OUT, "10-empresas.png"), fullPage: true });
fs.writeFileSync(path.join(OUT, "empresas.html"), await page.content());

// Try to capture json data inside the page or via API
const tables = await page.evaluate(() => {
  const rows = [];
  document.querySelectorAll("table tr").forEach((tr) => {
    const cells = [...tr.querySelectorAll("th, td")].map((c) => (c.textContent || "").trim());
    if (cells.length) rows.push(cells);
  });
  return rows;
});
console.log("table rows:", tables.length);
fs.writeFileSync(path.join(OUT, "empresas-table.json"), JSON.stringify(tables, null, 2));

// Try direct API discovery
const apiTries = [
  "/api/v3/companies",
  "/api/v3/company/companies",
  "/api/v3/companies/list",
  "/api/v3/people",
  "/api/v3/employees",
];
for (const ep of apiTries) {
  try {
    const r = await page.evaluate(async (url) => {
      const res = await fetch(url);
      const txt = await res.text();
      return { status: res.status, len: txt.length, sample: txt.slice(0, 600) };
    }, "https://core.sistemaeso.com.br" + ep);
    console.log(`api ${ep} → ${r.status} ${r.len}B`, r.sample.slice(0, 200));
  } catch (e) {
    console.log(`api ${ep} → err`, e.message);
  }
}

// Look for menus that take to "Pessoas" or funcionarios
console.log("\n→ /person/persontags");
await page.goto("https://core.sistemaeso.com.br/person/persontags", { waitUntil: "networkidle", timeout: 30000 }).catch(() => {});
await page.screenshot({ path: path.join(OUT, "11-persontags.png"), fullPage: true });

// Discover full menu by hovering on hamburger / clicking everything
console.log("\n→ list all anchor hrefs");
const links = await page.evaluate(() => {
  return [...document.querySelectorAll("a[href]")]
    .map((a) => ({ text: (a.textContent || "").trim(), href: a.getAttribute("href") }))
    .filter((l) => l.href && l.href.startsWith("/"));
});
const byHref = {};
for (const l of links) {
  if (l.text.length > 0 && l.text.length < 80) byHref[l.href] = l.text;
}
fs.writeFileSync(path.join(OUT, "all-links.json"), JSON.stringify(byHref, null, 2));
console.log("internal links found:", Object.keys(byHref).length);

// Print links containing: pessoa, person, funcion, traba, colab, empre, cad
Object.entries(byHref)
  .filter(([href, t]) => /pessoa|person|funcion|traba|colab|empresa|cad|cnpj|cpf/i.test(href + " " + t))
  .forEach(([href, t]) => console.log(`  ${href}\t${t}`));

console.log("\nAPI calls captured during session:", apiLogs.length);
fs.writeFileSync(path.join(OUT, "api-calls.json"), JSON.stringify(apiLogs, null, 2));
apiLogs.slice(0, 30).forEach((c) => console.log(`  ${c.status} ${c.method} ${c.url}`));

await browser.close();
