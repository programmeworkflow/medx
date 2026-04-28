// ESO HTTP helpers reused by sync-companies and sync-workers
const BASE = "https://core.sistemaeso.com.br";

export interface CookieJar {
  cookies: Map<string, string>;
}

function setCookieFromHeader(jar: CookieJar, raw: string[] | string | null) {
  if (!raw) return;
  const arr = Array.isArray(raw) ? raw : raw.split(/,(?=\s*\w+=)/);
  for (const c of arr) {
    const [first] = c.split(";");
    const eq = first.indexOf("=");
    if (eq < 0) continue;
    const k = first.slice(0, eq).trim();
    const v = first.slice(eq + 1).trim();
    if (k) jar.cookies.set(k, v);
  }
}
function cookieHeader(jar: CookieJar): string {
  return [...jar.cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

export async function esoFetch(
  jar: CookieJar,
  url: string,
  init?: { method?: string; body?: string; xhr?: boolean }
) {
  const r = await fetch(url, {
    method: init?.method ?? "GET",
    headers: {
      Cookie: cookieHeader(jar),
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "MedX-ESO/1.0",
      ...(init?.xhr ? { "X-Requested-With": "XMLHttpRequest", Accept: "application/json" } : { Accept: "*/*" }),
    },
    body: init?.body,
    redirect: "manual",
  });
  setCookieFromHeader(jar, (r.headers as any).getSetCookie?.() ?? r.headers.get("set-cookie"));
  return r;
}

export async function loginEso(email: string, password: string): Promise<CookieJar> {
  const jar: CookieJar = { cookies: new Map() };
  const r1 = await esoFetch(jar, `${BASE}/account/login`);
  if (r1.status !== 200) throw new Error(`GET /account/login: ${r1.status}`);
  const html = await r1.text();
  const tok = html.match(/name="__RequestVerificationToken"[^>]*value="([^"]+)"/);
  if (!tok) throw new Error("anti-forgery token não encontrado");
  const body = new URLSearchParams({
    Email: email,
    Password: password,
    RememberMe: "false",
    __RequestVerificationToken: tok[1],
  });
  const r2 = await esoFetch(jar, `${BASE}/account/login`, { method: "POST", body: body.toString() });
  if (r2.status !== 302 || !jar.cookies.has(".ESO.Core.Identity")) {
    throw new Error(`Login falhou (HTTP ${r2.status})`);
  }
  return jar;
}

export interface EsoCompany {
  Id: number;
  Name: string;
  SocialName?: string;
  DocumentNumber: string;
  BusinessDocumentTypeName: string;
  IsEmployer: boolean;
}

async function fetchCompaniesPage(jar: CookieJar, page: number) {
  const body = new URLSearchParams({
    personGroup: "Company",
    page: String(page),
    searchEsocial: "0",
    searchA1Certificate: "0-true",
    searchFuncionarios: "all",
  });
  const r = await esoFetch(jar, `${BASE}/api/core/personcompanyformainlisting`, {
    method: "POST",
    body: body.toString(),
    xhr: true,
  });
  if (r.status !== 200) throw new Error(`companies p${page}: ${r.status}`);
  return await r.json();
}

export async function listAllCompanies(jar: CookieJar): Promise<EsoCompany[]> {
  const first = await fetchCompaniesPage(jar, 1);
  const totalPages: number = first.Pagination?.TotalPages ?? 1;
  const all: EsoCompany[] = [...(first.Content || [])];
  if (totalPages <= 1) return all;

  // Parallelize remaining pages, 4 at a time, to keep ESO happy
  const concurrency = 4;
  const queue: number[] = [];
  for (let p = 2; p <= totalPages; p++) queue.push(p);
  while (queue.length) {
    const batch = queue.splice(0, concurrency);
    const results = await Promise.all(batch.map((p) => fetchCompaniesPage(jar, p).catch((e) => ({ Content: [], _err: e?.message }))));
    for (const r of results) {
      if (r?.Content?.length) all.push(...r.Content);
    }
  }
  return all;
}

export interface EsoWorker {
  Id: number;
  Name: string;
  Cpf: string;
  AdmissionDate?: string;
  TerminationDate?: string;
  Status?: string;
}

export async function listWorkersOf(jar: CookieJar, companyId: number): Promise<EsoWorker[]> {
  const all: EsoWorker[] = [];
  let page = 1;
  while (true) {
    const body = new URLSearchParams({ page: String(page), orderBy: "workername" });
    const r = await esoFetch(
      jar,
      `${BASE}/api/core/workersformainlisting?companyid=${companyId}`,
      { method: "POST", body: body.toString(), xhr: true }
    );
    if (r.status !== 200) break;
    const j: any = await r.json();
    const content = j.Content || [];
    if (!content.length) break;
    all.push(
      ...content.map((c: any) => ({
        Id: c.WorkerId ?? c.Id ?? c.PersonId,
        Name: c.WorkerName ?? c.PersonName ?? c.Name ?? "",
        Cpf: String(c.DocumentNumber ?? c.Cpf ?? "").replace(/\D/g, ""),
        AdmissionDate: c.HireDateObj?.Iso ?? c.AdmissionDate ?? null,
        TerminationDate: c.TerminationDateObj?.Iso ?? c.TerminationDate ?? null,
        Status: c.IsAbsentFromJob ? "afastado" : "ativo",
      }))
    );
    const tp = j.Pagination?.TotalPages ?? 0;
    if (page >= tp) break;
    page++;
    if (page > 50) break;
  }
  return all;
}

// In-memory module-scope cache so subsequent invocations within the same warm
// instance can reuse the session and skip re-login (~1.5s savings per call).
let _cachedJar: CookieJar | null = null;
let _cachedAt = 0;
export async function getEsoSession(email: string, password: string): Promise<CookieJar> {
  if (_cachedJar && Date.now() - _cachedAt < 10 * 60 * 1000) return _cachedJar;
  _cachedJar = await loginEso(email, password);
  _cachedAt = Date.now();
  return _cachedJar;
}
