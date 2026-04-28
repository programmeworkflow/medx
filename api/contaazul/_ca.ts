// Conta Azul OAuth helpers + token storage
import { supaAdmin, encryptSecret, decryptSecret } from "../esocial/_lib.js";

export const AUTH_URL = "https://auth.contaazul.com/oauth2/authorize";
export const TOKEN_URL = "https://auth.contaazul.com/oauth2/token";
export const API_BASE = "https://api-v2.contaazul.com";

export const CLIENT_ID = process.env.CONTA_AZUL_CLIENT_ID || "";
export const CLIENT_SECRET = process.env.CONTA_AZUL_CLIENT_SECRET || "";
export const REDIRECT_URI =
  process.env.CONTA_AZUL_REDIRECT_URI ||
  "https://dist-bay-three-17.vercel.app/api/contaazul/callback";
export const FRONT_URL =
  process.env.CONTA_AZUL_FRONTEND_URL || "https://medwork-final-deploy.vercel.app";

export function getAuthorizeUrl(state: string) {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    state,
    scope: "openid profile aws.cognito.signin.user.admin",
  });
  return `${AUTH_URL}?${params.toString()}`;
}

export async function saveTokens(access: string, refresh: string, expiresIn: number) {
  const sb = supaAdmin();
  const expiresAt = new Date(Date.now() + (expiresIn || 3600) * 1000 - 120000).toISOString();
  await sb.from("contaazul_tokens").upsert(
    {
      id: 1,
      access_token: encryptSecret(access),
      refresh_token: encryptSecret(refresh),
      expires_at: expiresAt,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "id" }
  );
}

export async function loadTokens() {
  const sb = supaAdmin();
  const { data } = await sb.from("contaazul_tokens").select("*").eq("id", 1).maybeSingle();
  if (!data) return null;
  return {
    access_token: decryptSecret(data.access_token),
    refresh_token: decryptSecret(data.refresh_token),
    expires_at: data.expires_at,
  };
}

export async function exchangeCode(code: string) {
  const params = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT_URI,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
  });
  const r = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`exchangeCode HTTP ${r.status}: ${t.slice(0, 300)}`);
  }
  const j: any = await r.json();
  await saveTokens(j.access_token, j.refresh_token, j.expires_in);
  return j;
}

export async function refreshAccessToken(refresh: string) {
  const params = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refresh,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
  });
  const r = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`refresh HTTP ${r.status}: ${t.slice(0, 200)}`);
  }
  const j: any = await r.json();
  await saveTokens(j.access_token, j.refresh_token || refresh, j.expires_in);
  return j.access_token as string;
}

export async function getValidAccessToken(): Promise<string> {
  const t = await loadTokens();
  if (!t) throw new Error("Conta Azul não conectado. Use /api/contaazul/authorize.");
  const exp = new Date(t.expires_at).getTime();
  if (exp <= Date.now() + 60000) {
    return await refreshAccessToken(t.refresh_token);
  }
  return t.access_token;
}

export async function caApi(method: string, endpoint: string, body?: any) {
  const token = await getValidAccessToken();
  const init: any = {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  const r = await fetch(`${API_BASE}${endpoint}`, init);
  const text = await r.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {}
  if (!r.ok) {
    const msg =
      typeof json === "object" && json !== null
        ? JSON.stringify(json).slice(0, 500)
        : json?.message || json?.error || text.slice(0, 300);
    throw new Error(`Conta Azul ${r.status} ${method} ${endpoint}: ${msg}`);
  }
  return json;
}
