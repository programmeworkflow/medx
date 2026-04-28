// Captura payload completo das APIs de listagem
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

const captured = [];
page.on("request", (req) => {
  if (req.url().includes("personcompany") || req.url().includes("/api/core/")) {
    captured.push({
      type: "REQ",
      method: req.method(),
      url: req.url(),
      headers: req.headers(),
      body: req.postData(),
    });
  }
});
page.on("response", async (res) => {
  const url = res.url();
  if (url.includes("personcompany") || url.includes("/api/core/")) {
    try {
      const text = await res.text();
      captured.push({
        type: "RES",
        url,
        status: res.status(),
        ct: res.headers()["content-type"],
        bodySample: text.slice(0, 4000),
        bodyLen: text.length,
      });
    } catch (_) {}
  }
});

console.log("→ login");
await page.goto(URL_LOGIN, { waitUntil: "domcontentloaded" });
await page.waitForSelector('input[name="UserName"], input[type="email"], input[name*="mail" i]', { timeout: 15000 });
const emailField = await page.evaluate(() => {
  const inp = [...document.querySelectorAll("input")].find(
    (i) => /mail|user|login/i.test(i.name || "") || i.type === "email" || /mail|usuário|usuario|login/i.test(i.placeholder || "")
  );
  return inp ? inp.name : null;
});
console.log("email field name:", emailField);
await page.fill(`input[name="${emailField}"]`, EMAIL);
await page.fill('input[type="password"]', PASS);
await page.click('button[type="submit"]');
await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});

console.log("→ /company/companies (force load)");
await page.goto("https://core.sistemaeso.com.br/company/companies", { waitUntil: "networkidle", timeout: 30000 }).catch(() => {});
await page.waitForTimeout(3000);

// Try paginated load
for (let p = 1; p <= 3; p++) {
  await page.goto(`https://core.sistemaeso.com.br/company/companies?page=${p}`, { waitUntil: "networkidle", timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(1500);
}

// Now visit one workersplanning page to see listing of CPFs
const someCompanyIds = await page.evaluate(() => {
  return [...document.querySelectorAll("a[href*='/company/workersplanning?companyid=']")]
    .slice(0, 3)
    .map((a) => a.getAttribute("href"));
});
console.log("workersplanning links:", someCompanyIds);

for (const link of someCompanyIds) {
  console.log("→ visit", link);
  await page.goto("https://core.sistemaeso.com.br" + link, { waitUntil: "networkidle", timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(2500);
}
await page.screenshot({ path: path.join(OUT, "30-workers.png"), fullPage: true });
fs.writeFileSync(path.join(OUT, "workers.html"), await page.content());

fs.writeFileSync(path.join(OUT, "captured.json"), JSON.stringify(captured, null, 2));
console.log("\nCaptured", captured.length, "events");
captured
  .filter((c) => c.type === "RES")
  .forEach((c) => console.log(`  ${c.status} ${c.url} ${c.bodyLen}B  ct=${c.ct}`));

console.log("\n=== sample bodies ===");
captured
  .filter((c) => c.type === "RES" && c.status === 200 && c.bodyLen > 100)
  .slice(0, 3)
  .forEach((c) => {
    console.log("\n--- " + c.url + " ---");
    console.log(c.bodySample.slice(0, 1200));
  });

await browser.close();
