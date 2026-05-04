// Login via Cognito IDP no User Pool da Conta Azul (sa-east-1_Vp83J11wA).
// Client app usa secret => precisa de SECRET_HASH = base64(HMAC_SHA256(secret, username + clientId)).
// AuthFlow USER_PASSWORD_AUTH evita o handshake SRP (mais simples e Node-friendly).
// Tokens IdToken/AccessToken Cognito são aceitos pelos endpoints internos
// services.contaazul.com/contaazul-bff/* e /app/serviceinvoice/*.
import crypto from "node:crypto";
import { supaAdmin, encryptSecret, decryptSecret } from "../esocial/_lib.js";

const COGNITO_REGION = "sa-east-1";
const COGNITO_URL = `https://cognito-idp.${COGNITO_REGION}.amazonaws.com/`;
// O client Cognito que a UI web da CA usa — emite AccessToken de 24h e suporta
// refresh sem SECRET_HASH (public client, sem secret). O client OAuth2
// (CONTA_AZUL_CLIENT_ID) emite tokens de 1h e refresh falha pós-MFA.
const CLIENT_ID =
  process.env.CONTA_AZUL_COGNITO_CLIENT_ID || "3189s90f7qd59smn0r9vua6ld8";
// O client público da UI não tem secret. Mas mantemos o secret do OAuth2 caso
// alguém use um client custom com secret.
const CLIENT_SECRET = process.env.CONTA_AZUL_COGNITO_CLIENT_SECRET || "";
const TOTP_SECRET = (process.env.CONTA_AZUL_TOTP_SECRET || "").replace(/\s+/g, "").toUpperCase();

// RFC 6238 TOTP — base32 seed → código de 6 dígitos válido por 30s
function base32Decode(s: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = s.replace(/=+$/, "").replace(/\s+/g, "").toUpperCase();
  let bits = "";
  for (const c of clean) {
    const idx = alphabet.indexOf(c);
    if (idx < 0) throw new Error(`TOTP seed tem caractere inválido: ${c}`);
    bits += idx.toString(2).padStart(5, "0");
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}

function totpNow(secretBase32: string): string {
  const key = base32Decode(secretBase32);
  const counter = Math.floor(Date.now() / 1000 / 30);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac("sha1", key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return (code % 1_000_000).toString().padStart(6, "0");
}

interface SessionTokens {
  id_token: string;
  access_token: string;
  refresh_token: string;
  expires_at: string;
  email: string;
}

function secretHash(username: string): string | null {
  // Client público (sem secret) não usa SECRET_HASH. Retorna null pra omitir.
  if (!CLIENT_SECRET) return null;
  return crypto
    .createHmac("sha256", CLIENT_SECRET)
    .update(username + CLIENT_ID)
    .digest("base64");
}

function withSecretHash(params: Record<string, string>, username: string) {
  const sh = secretHash(username);
  if (sh) params.SECRET_HASH = sh;
  return params;
}

function jwtExpiry(jwt: string): number {
  const payload = JSON.parse(
    Buffer.from(jwt.split(".")[1], "base64url").toString("utf8")
  );
  return (payload.exp as number) * 1000;
}

async function cognitoCall<T = any>(target: string, body: any): Promise<T> {
  const r = await fetch(COGNITO_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-amz-json-1.1",
      "X-Amz-Target": `AWSCognitoIdentityProviderService.${target}`,
    },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {}
  if (!r.ok) {
    const msg = json?.message || json?.__type || text.slice(0, 300);
    throw new Error(`Cognito ${target} ${r.status}: ${msg}`);
  }
  return json as T;
}

async function loginPassword(email: string, senha: string): Promise<SessionTokens> {
  const r: any = await cognitoCall("InitiateAuth", {
    AuthFlow: "USER_PASSWORD_AUTH",
    ClientId: CLIENT_ID,
    AuthParameters: withSecretHash({ USERNAME: email, PASSWORD: senha }, email),
  });

  // Resposta direta sem MFA
  if (r?.AuthenticationResult) {
    const a = r.AuthenticationResult;
    return {
      id_token: a.IdToken,
      access_token: a.AccessToken,
      refresh_token: a.RefreshToken,
      expires_at: new Date(jwtExpiry(a.IdToken) - 120000).toISOString(),
      email,
    };
  }

  // MFA TOTP — responde com código gerado a partir do seed
  if (r?.ChallengeName === "SOFTWARE_TOKEN_MFA") {
    if (!TOTP_SECRET) {
      throw new Error(
        "Conta exige MFA TOTP mas CONTA_AZUL_TOTP_SECRET não está configurado nas env vars"
      );
    }
    const username = r.ChallengeParameters?.USER_ID_FOR_SRP || email;
    const code = totpNow(TOTP_SECRET);
    const r2: any = await cognitoCall("RespondToAuthChallenge", {
      ChallengeName: "SOFTWARE_TOKEN_MFA",
      ClientId: CLIENT_ID,
      Session: r.Session,
      ChallengeResponses: withSecretHash(
        { USERNAME: username, SOFTWARE_TOKEN_MFA_CODE: code },
        username
      ),
    });
    const a = r2?.AuthenticationResult;
    if (!a) {
      throw new Error(
        `MFA challenge não retornou AuthenticationResult: ${JSON.stringify(r2).slice(0, 250)}`
      );
    }
    return {
      id_token: a.IdToken,
      access_token: a.AccessToken,
      refresh_token: a.RefreshToken,
      expires_at: new Date(jwtExpiry(a.IdToken) - 120000).toISOString(),
      email,
    };
  }

  throw new Error(
    `Cognito retornou challenge não suportado: ${JSON.stringify(r).slice(0, 250)}`
  );
}

async function refreshTokens(email: string, refreshToken: string): Promise<SessionTokens> {
  const r: any = await cognitoCall("InitiateAuth", {
    AuthFlow: "REFRESH_TOKEN_AUTH",
    ClientId: CLIENT_ID,
    AuthParameters: withSecretHash({ REFRESH_TOKEN: refreshToken }, email),
  });
  const a = r?.AuthenticationResult;
  if (!a) throw new Error("Refresh não retornou AuthenticationResult");
  return {
    id_token: a.IdToken,
    access_token: a.AccessToken,
    refresh_token: a.RefreshToken || refreshToken,
    expires_at: new Date(jwtExpiry(a.IdToken) - 120000).toISOString(),
    email,
  };
}

async function saveSession(t: SessionTokens) {
  const sb = supaAdmin();
  await sb.from("contaazul_session").upsert(
    {
      id: 1,
      email: t.email,
      id_token: encryptSecret(t.id_token),
      access_token: encryptSecret(t.access_token),
      refresh_token: encryptSecret(t.refresh_token),
      expires_at: t.expires_at,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "id" }
  );
}

async function loadSession(): Promise<SessionTokens | null> {
  const sb = supaAdmin();
  const { data } = await sb.from("contaazul_session").select("*").eq("id", 1).maybeSingle();
  if (!data) return null;
  return {
    id_token: decryptSecret(data.id_token),
    access_token: decryptSecret(data.access_token),
    refresh_token: decryptSecret(data.refresh_token),
    expires_at: data.expires_at,
    email: data.email,
  };
}

export async function getValidIdToken(): Promise<string> {
  // Prefere usar sessão Cognito existente (mesma usada pelo BFF). Só cai
  // pro auto-login se a sessão estiver expirada e env vars existirem.
  const cached = await loadSession();
  if (cached?.id_token && new Date(cached.expires_at).getTime() > Date.now() + 60000) {
    return cached.id_token;
  }

  if (cached?.refresh_token && cached.email) {
    try {
      const refreshed = await refreshTokens(cached.email, cached.refresh_token);
      await saveSession(refreshed);
      return refreshed.id_token;
    } catch (_) {}
  }

  const email = process.env.CONTA_AZUL_EMAIL;
  const senha = process.env.CONTA_AZUL_SENHA;
  if (!email || !senha) {
    throw new Error("Sessão Cognito expirada e CONTA_AZUL_EMAIL/SENHA não configurados");
  }
  const fresh = await loginPassword(email, senha);
  await saveSession(fresh);
  return fresh.id_token;
}

// === Sessão BFF baseada em cookies copiados da UI ===
// Os endpoints services.contaazul.com não aceitam Authorization Bearer —
// dependem dos cookies x-ca-auth (Access Token Cognito), x-ca-device-key
// e x-ca-session-id, setados pela UI app web. Salvamos esses cookies em
// Supabase e o usuário atualiza ~1x/dia (token tem ~24h de vida).

interface BffCookies {
  x_ca_auth: string;
  x_ca_device_key: string;
  x_ca_session_id: string;
  expires_at: string;
}

export async function saveBffCookies(c: Omit<BffCookies, "expires_at">) {
  // Decodifica o exp do JWT pra saber quando expira
  let exp = Date.now() + 12 * 3600_000;
  try {
    const payload = JSON.parse(
      Buffer.from(c.x_ca_auth.split(".")[1], "base64url").toString("utf8")
    );
    if (payload.exp) exp = payload.exp * 1000;
  } catch {}
  const sb = supaAdmin();
  await sb.from("contaazul_session").upsert(
    {
      id: 1,
      email: process.env.CONTA_AZUL_EMAIL || "manual",
      // reaproveita as colunas existentes (cifradas)
      id_token: encryptSecret(c.x_ca_auth),
      access_token: encryptSecret(c.x_ca_device_key),
      refresh_token: encryptSecret(c.x_ca_session_id),
      expires_at: new Date(exp - 120000).toISOString(),
      updated_at: new Date().toISOString(),
    },
    { onConflict: "id" }
  );
}

export async function loadBffCookies(): Promise<BffCookies | null> {
  const sb = supaAdmin();
  const { data } = await sb.from("contaazul_session").select("*").eq("id", 1).maybeSingle();
  if (!data) return null;
  return {
    x_ca_auth: decryptSecret(data.id_token),
    x_ca_device_key: decryptSecret(data.access_token),
    x_ca_session_id: decryptSecret(data.refresh_token),
    expires_at: data.expires_at,
  };
}

// === Login interativo Cognito (chamado 1x quando refresh expira) ===
// Recebe email/senha + código TOTP do app autenticador. Salva AccessToken
// (= x-ca-auth) + RefreshToken Cognito (que vale ~30 dias) na tabela.

interface CognitoSession {
  access_token: string; // = x-ca-auth (JWT)
  refresh_token: string; // Cognito refresh — vale ~30 dias
  expires_at: string; // ISO do exp do access_token
  session_id: string; // UUID gerado 1x, reusado
  email: string;
}

// Faz o fluxo Cognito completo: USER_PASSWORD_AUTH + (MFA TOTP se exigido).
// totpCode pode ser fornecido pelo user OU gerado automaticamente do TOTP_SECRET.
async function doCognitoLogin(
  email: string,
  senha: string,
  totpCode?: string
): Promise<{ AccessToken: string; RefreshToken: string }> {
  const r: any = await cognitoCall("InitiateAuth", {
    AuthFlow: "USER_PASSWORD_AUTH",
    ClientId: CLIENT_ID,
    AuthParameters: withSecretHash({ USERNAME: email, PASSWORD: senha }, email),
  });

  let auth = r?.AuthenticationResult;

  if (!auth && r?.ChallengeName === "SOFTWARE_TOKEN_MFA") {
    // Usa TOTP fornecido ou gera do seed
    let code = totpCode;
    if (!code && TOTP_SECRET) {
      code = totpNow(TOTP_SECRET);
    }
    if (!code) {
      throw new Error("MFA_REQUIRED: passe totp_code ou configure CONTA_AZUL_TOTP_SECRET");
    }
    const username = r.ChallengeParameters?.USER_ID_FOR_SRP || email;
    const r2: any = await cognitoCall("RespondToAuthChallenge", {
      ChallengeName: "SOFTWARE_TOKEN_MFA",
      ClientId: CLIENT_ID,
      Session: r.Session,
      ChallengeResponses: withSecretHash(
        { USERNAME: username, SOFTWARE_TOKEN_MFA_CODE: code },
        username
      ),
    });
    auth = r2?.AuthenticationResult;
    if (!auth) {
      throw new Error(
        `MFA não retornou AuthenticationResult: ${JSON.stringify(r2).slice(0, 250)}`
      );
    }
  }

  if (!auth) {
    throw new Error(`Login Cognito não suportado: ${JSON.stringify(r).slice(0, 250)}`);
  }

  return { AccessToken: auth.AccessToken, RefreshToken: auth.RefreshToken };
}

export async function cognitoLoginInteractive(
  email: string,
  senha: string,
  totpCode?: string
): Promise<CognitoSession> {
  const tokens = await doCognitoLogin(email, senha, totpCode);
  // Salva email + senha (cifrada) pra cron poder fazer auto-login depois
  return saveCognitoSession(email, tokens.AccessToken, tokens.RefreshToken, null, senha);
}

// Auto-login: usa email+senha cifrados no banco + TOTP gerado do seed.
// Chamado pelo cron quando refresh falha.
async function cognitoAutoLogin(): Promise<CognitoSession> {
  const sb = supaAdmin();
  const { data } = await sb.from("contaazul_session").select("*").eq("id", 1).maybeSingle();
  if (!data) throw new Error("Sem sessão prévia. Faça login interativo 1x via /api/contaazul/cognito-login");
  const email = data.email;
  let senha: string;
  try {
    senha = decryptSecret(data.access_token);
    if (!senha) throw new Error("Senha não está salva — re-logar interativo");
  } catch {
    throw new Error("Senha não está salva — re-logar interativo");
  }
  if (!TOTP_SECRET) {
    throw new Error("CONTA_AZUL_TOTP_SECRET não configurado");
  }
  const tokens = await doCognitoLogin(email, senha, undefined);
  return saveCognitoSession(email, tokens.AccessToken, tokens.RefreshToken, data.session_id, senha);
}

function saveCognitoSessionLocal(s: CognitoSession, senha: string | null) {
  const sb = supaAdmin();
  return sb.from("contaazul_session").upsert(
    {
      id: 1,
      email: s.email,
      id_token: encryptSecret(s.access_token),
      // Reusa coluna access_token pra senha cifrada (legado, não usada no modo Cognito)
      access_token: senha != null ? encryptSecret(senha) : encryptSecret(""),
      refresh_token: encryptSecret(""),
      cognito_refresh_token: encryptSecret(s.refresh_token),
      session_id: s.session_id,
      expires_at: s.expires_at,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "id" }
  );
}

async function saveCognitoSession(
  email: string,
  accessToken: string,
  refreshToken: string,
  reuseSessionId?: string | null,
  senha?: string | null
): Promise<CognitoSession> {
  const expMs = jwtExpiry(accessToken);
  const session_id = reuseSessionId || crypto.randomUUID();
  const sess: CognitoSession = {
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_at: new Date(expMs - 120000).toISOString(),
    session_id,
    email,
  };
  // Se não veio senha, preserva a que estava no banco
  let senhaToSave = senha ?? null;
  if (senhaToSave === null) {
    try {
      const sb = supaAdmin();
      const { data } = await sb.from("contaazul_session").select("access_token").eq("id", 1).maybeSingle();
      if (data?.access_token) senhaToSave = decryptSecret(data.access_token);
    } catch {}
  }
  await saveCognitoSessionLocal(sess, senhaToSave);
  return sess;
}

async function loadCognitoSession(): Promise<CognitoSession | null> {
  const sb = supaAdmin();
  const { data } = await sb.from("contaazul_session").select("*").eq("id", 1).maybeSingle();
  if (!data?.cognito_refresh_token) return null;
  return {
    access_token: decryptSecret(data.id_token),
    refresh_token: decryptSecret(data.cognito_refresh_token),
    expires_at: data.expires_at,
    session_id: data.session_id || crypto.randomUUID(),
    email: data.email,
  };
}

// Renova o AccessToken via REFRESH_TOKEN_AUTH (sem MFA).
// Chamado pelo cron diário e on-demand quando expira.
// Passa DEVICE_KEY (extraído do AccessToken atual) — Cognito exige quando
// o login original gerou um device, senão retorna "does not support refresh
// token rotation".
export async function cognitoRefresh(): Promise<CognitoSession> {
  const cur = await loadCognitoSession();
  if (!cur) throw new Error("Sem sessão Cognito. Faça login via /api/contaazul/cognito-login");

  let deviceKey = "";
  try {
    const payload = JSON.parse(
      Buffer.from(cur.access_token.split(".")[1], "base64url").toString("utf8")
    );
    deviceKey = payload.device_key || "";
  } catch {}

  // Tenta REFRESH_TOKEN_AUTH primeiro. Se falhar (típico em fluxos pós-MFA
  // do app client da CA), cai no auto-login completo (precisa email+senha
  // salvos + CONTA_AZUL_TOTP_SECRET configurado).
  try {
    const params: Record<string, string> = withSecretHash(
      { REFRESH_TOKEN: cur.refresh_token },
      cur.email
    );
    if (deviceKey) params.DEVICE_KEY = deviceKey;

    const r: any = await cognitoCall("InitiateAuth", {
      AuthFlow: "REFRESH_TOKEN_AUTH",
      ClientId: CLIENT_ID,
      AuthParameters: params,
    });
    const a = r?.AuthenticationResult;
    if (a?.AccessToken) {
      return saveCognitoSession(
        cur.email,
        a.AccessToken,
        a.RefreshToken || cur.refresh_token,
        cur.session_id
      );
    }
  } catch (err: any) {
    // Refresh falhou — cai no fallback de auto-login
  }

  // Fallback: auto-login completo
  return cognitoAutoLogin();
}

export async function cognitoStatus() {
  const sess = await loadCognitoSession();
  if (!sess) return { connected: false };
  const expiresAt = new Date(sess.expires_at).getTime();
  let access_token_client_id = "?";
  let access_token_token_use = "?";
  let access_token_iat: string | null = null;
  try {
    const payload = JSON.parse(
      Buffer.from(sess.access_token.split(".")[1], "base64url").toString("utf8")
    );
    access_token_client_id = payload.client_id || "?";
    access_token_token_use = payload.token_use || "?";
    access_token_iat = new Date((payload.iat || 0) * 1000).toISOString();
  } catch {}
  let access_token_device_key = "?";
  let access_token_scope = "?";
  try {
    const payload = JSON.parse(
      Buffer.from(sess.access_token.split(".")[1], "base64url").toString("utf8")
    );
    access_token_device_key = payload.device_key || "(none)";
    access_token_scope = payload.scope || "?";
  } catch {}
  const expiresInSeconds = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
  return {
    connected: true,
    needs_relogin: expiresInSeconds < 3600, // alerta quando faltam < 1h
    email: sess.email,
    access_token_expires_at: sess.expires_at,
    access_token_expires_in_seconds: expiresInSeconds,
    session_id: sess.session_id,
    debug: {
      access_token_client_id,
      access_token_token_use,
      access_token_iat,
      access_token_device_key,
      access_token_scope,
      configured_client_id: CLIENT_ID,
      has_client_secret: !!CLIENT_SECRET,
      refresh_token_length: sess.refresh_token?.length || 0,
    },
  };
}

// Cookies BFF derivados da sessão Cognito (usado pelo caBffSession quando
// existe sessão Cognito). Renova automaticamente se AccessToken expirou.
async function bffCookiesFromCognito(): Promise<BffCookies | null> {
  let sess = await loadCognitoSession();
  if (!sess) return null;
  if (new Date(sess.expires_at).getTime() < Date.now() + 60000) {
    sess = await cognitoRefresh();
  }
  // device_key vem dentro do JWT
  let deviceKey = "";
  try {
    const payload = JSON.parse(
      Buffer.from(sess.access_token.split(".")[1], "base64url").toString("utf8")
    );
    deviceKey = payload.device_key || "";
  } catch {}
  return {
    x_ca_auth: sess.access_token,
    x_ca_device_key: deviceKey,
    x_ca_session_id: sess.session_id,
    expires_at: sess.expires_at,
  };
}

export async function caBffSession(
  method: string,
  url: string,
  body?: any,
  extraHeaders: Record<string, string> = {}
) {
  // Prefere sessão Cognito (auto-refresh). Fallback pros cookies copiados.
  let c: BffCookies | null = await bffCookiesFromCognito();
  if (!c) c = await loadBffCookies();
  if (!c) {
    throw new Error(
      "Sessão Conta Azul não configurada. Faça login em /api/contaazul/cognito-login ou cole cookies em /api/contaazul/set-bff-cookies"
    );
  }
  if (new Date(c.expires_at).getTime() < Date.now()) {
    throw new Error(
      `Sessão BFF expirou em ${c.expires_at}. Refaça login Cognito ou recopie cookies.`
    );
  }
  const cookieHeader = [
    `x-ca-auth=${c.x_ca_auth}`,
    `x-ca-device-key=${c.x_ca_device_key}`,
    `x-ca-session-id=${c.x_ca_session_id}`,
  ].join("; ");
  const init: any = {
    method,
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Cookie: cookieHeader,
      Origin: "https://pro.contaazul.com",
      Referer: "https://pro.contaazul.com/",
      ...extraHeaders,
    },
    redirect: "manual",
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  const r = await fetch(url, init);
  const text = await r.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {}
  return {
    ok: r.ok,
    status: r.status,
    headers: Object.fromEntries(r.headers.entries()),
    data: json,
    text: text.slice(0, 2000),
  };
}
