/**
 * Tokens efêmeros para o CLI de importação (Conformidade).
 *
 * Usa JWT HS256 assinado com AUTH_SECRET.
 * Não precisa de biblioteca externa — implementação inline com Web Crypto API.
 *
 * Validade: 2h (padrão), até 24h (máximo — clampeado).
 * Payload mínimo: { iat, exp, jti, sub (userId), role, kind: "import_cli" }
 */

const TEXT_ENC = new TextEncoder();
const TEXT_DEC = new TextDecoder();

function base64UrlEncode(bytes: ArrayBuffer | Uint8Array): string {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = "";
  for (let i = 0; i < b.length; i++) bin += String.fromCharCode(b[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function getKey(): Promise<CryptoKey> {
  // NextAuth v5 lê AUTH_SECRET ou NEXTAUTH_SECRET (legado). Suportar ambos.
  const secret = process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET;
  if (!secret) throw new Error("AUTH_SECRET / NEXTAUTH_SECRET não configurado");
  return crypto.subtle.importKey(
    "raw",
    TEXT_ENC.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

// TTL padrão de 2h; máximo de 24h. TTLs maiores são clampeados.
const TTL_PADRAO_HORAS = 2;
const TTL_MAX_HORAS    = 24;

export interface ImportTokenPayload {
  sub: string;       // userId
  role: string;      // role do usuário no momento da geração
  kind: "import_cli";
  jti: string;       // id único do token (base para futura revogação via tabela)
  iat: number;
  exp: number;
}

export async function gerarImportToken(
  userId: string,
  role: string,
  ttlHoras = TTL_PADRAO_HORAS,
): Promise<{ token: string; expiraEm: Date }> {
  const now = Math.floor(Date.now() / 1000);
  // Clampa o TTL ao máximo permitido (e a um mínimo positivo).
  const horas = Math.min(Math.max(ttlHoras, 1), TTL_MAX_HORAS);
  const exp = now + horas * 3600;
  const payload: ImportTokenPayload = {
    sub:  userId,
    role,
    kind: "import_cli",
    jti:  crypto.randomUUID(),
    iat:  now,
    exp,
  };

  const header = { alg: "HS256", typ: "JWT" };
  const headerB64  = base64UrlEncode(TEXT_ENC.encode(JSON.stringify(header)));
  const payloadB64 = base64UrlEncode(TEXT_ENC.encode(JSON.stringify(payload)));
  const data = `${headerB64}.${payloadB64}`;

  const key = await getKey();
  const sigBuf = await crypto.subtle.sign("HMAC", key, TEXT_ENC.encode(data));
  const sigB64 = base64UrlEncode(sigBuf);

  return {
    token:    `${data}.${sigB64}`,
    expiraEm: new Date(exp * 1000),
  };
}

export async function verificarImportToken(token: string): Promise<ImportTokenPayload | null> {
  const partes = token.split(".");
  if (partes.length !== 3) return null;
  const [headerB64, payloadB64, sigB64] = partes;

  try {
    const key = await getKey();
    const sigBytes = base64UrlDecode(sigB64);
    // Cópia explícita pra ArrayBuffer (resolve variance Uint8Array<ArrayBufferLike>)
    const sigBuf = new ArrayBuffer(sigBytes.byteLength);
    new Uint8Array(sigBuf).set(sigBytes);
    const ok = await crypto.subtle.verify(
      "HMAC",
      key,
      sigBuf,
      TEXT_ENC.encode(`${headerB64}.${payloadB64}`),
    );
    if (!ok) return null;

    const payload = JSON.parse(TEXT_DEC.decode(base64UrlDecode(payloadB64))) as ImportTokenPayload;
    if (payload.kind !== "import_cli") return null;
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;

    return payload;
  } catch {
    return null;
  }
}
