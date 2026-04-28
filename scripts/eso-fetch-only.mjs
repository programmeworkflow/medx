// Tenta fazer login no ESO via fetch puro (sem browser) para usar Vercel Functions
import { CookieJar } from "tough-cookie";

const EMAIL = "medwork.financeiro@gmail.com";
const PASS = "medWORK123*";
const BASE = "https://core.sistemaeso.com.br";

// Helper: fetch with cookie persistence
const cookies = new Map(); // name -> value
function setCookies(setCookieHeaders) {
  if (!setCookieHeaders) return;
  const arr = Array.isArray(setCookieHeaders) ? setCookieHeaders : setCookieHeaders.split(/,(?=\s*\w+=)/);
  for (const c of arr) {
    const [first] = c.split(";");
    const eq = first.indexOf("=");
    const k = first.slice(0, eq).trim();
    const v = first.slice(eq + 1).trim();
    if (k) cookies.set(k, v);
  }
}
function cookieHeader() {
  return [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

async function get(url) {
  const r = await fetch(url, {
    headers: { Cookie: cookieHeader(), "User-Agent": "Mozilla/5.0 MedX/1.0" },
    redirect: "manual",
  });
  setCookies(r.headers.getSetCookie?.() || r.headers.get("set-cookie"));
  return r;
}
async function post(url, body, contentType) {
  const r = await fetch(url, {
    method: "POST",
    headers: {
      Cookie: cookieHeader(),
      "Content-Type": contentType || "application/x-www-form-urlencoded",
      "X-Requested-With": "XMLHttpRequest",
      Accept: "application/json, text/html",
      "User-Agent": "Mozilla/5.0 MedX/1.0",
    },
    body,
    redirect: "manual",
  });
  setCookies(r.headers.getSetCookie?.() || r.headers.get("set-cookie"));
  return r;
}

console.log("→ GET login page");
const r1 = await get(`${BASE}/account/login`);
console.log("status", r1.status, "cookies:", [...cookies.keys()]);
const html = await r1.text();

// Try to find anti-forgery token
const tokenMatch = html.match(/name="__RequestVerificationToken"\s+type="hidden"\s+value="([^"]+)"/) ||
  html.match(/name="__RequestVerificationToken"[^>]*value="([^"]+)"/);
const token = tokenMatch ? tokenMatch[1] : null;
console.log("__RequestVerificationToken found:", !!token);

const formInputs = [...html.matchAll(/<input[^>]*name="([^"]+)"[^>]*value="([^"]*)"/g)].map((m) => `${m[1]}=${m[2]}`);
console.log("hidden inputs:", formInputs.slice(0, 5).join(" | "));

// Submit login
const formBody = new URLSearchParams({
  Email: EMAIL,
  Password: PASS,
  RememberMe: "false",
  ...(token && { __RequestVerificationToken: token }),
});
console.log("→ POST login");
const r2 = await post(`${BASE}/account/login`, formBody.toString());
console.log("status", r2.status, "Location:", r2.headers.get("location"));
console.log("cookies after login:", [...cookies.keys()]);

// Try following redirect
let url = r2.headers.get("location");
let r3;
if (url) {
  r3 = await get(url.startsWith("http") ? url : BASE + url);
  console.log("after redirect status:", r3.status, "url:", url);
}

// Try the API call
console.log("\n→ POST /api/core/personcompanyformainlisting");
const apiBody = "personGroup=Company&page=1&searchEsocial=0&searchA1Certificate=0-true&searchFuncionarios=all";
const r4 = await post(`${BASE}/api/core/personcompanyformainlisting`, apiBody);
console.log("status:", r4.status);
const apiText = await r4.text();
console.log("body length:", apiText.length);
console.log("sample:", apiText.slice(0, 500));
