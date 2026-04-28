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

// Find a company with workers (15398344000178 has 5 from earlier sync)
const r = await page.evaluate(async () => {
  const body = new URLSearchParams({
    personGroup: "Company",
    page: "1",
    searchEsocial: "0",
    searchA1Certificate: "0-true",
    searchFuncionarios: "all",
    searchString: "15398344000178",
  });
  const r = await fetch("/api/core/personcompanyformainlisting", {
    method: "POST",
    body: body.toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Requested-With": "XMLHttpRequest" },
    credentials: "include",
  });
  return await r.text();
});
const cId = r.match(/"Id":(\d+)/)?.[1];
console.log("CompanyId for CNPJ 15398344000178:", cId);

const w = await page.evaluate(async (cid) => {
  const body = new URLSearchParams({ page: "1", orderBy: "workername" });
  const r = await fetch(`/api/core/workersformainlisting?companyid=${cid}`, {
    method: "POST",
    body: body.toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Requested-With": "XMLHttpRequest" },
    credentials: "include",
  });
  return await r.text();
}, cId);
console.log("Workers response:");
console.log(w.slice(0, 3000));
await browser.close();
