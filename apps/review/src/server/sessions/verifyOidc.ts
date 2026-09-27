import { fetchJwks, importRs256Jwk, type FetchJwksOptions, type JsonWebKey } from "./fetchJwks.ts";

const ISSUER = "https://token.actions.githubusercontent.com";
const AUDIENCE = "smithers-review";

/**
 * GitHub Actions OIDC claims the worker reads. Other claims may appear in the
 * token but are ignored: identity comes from immutable repository and owner IDs
 * and the trusted workflow from `job_workflow_ref`, the PR number (when
 * inferrable) from `event_name` + `ref`.
 */
export interface OidcClaims {
  iss: string;
  aud: string;
  exp: number;
  iat?: number;
  nbf?: number;
  repository: string;
  repository_owner?: string;
  repository_id?: string;
  repository_owner_id?: string;
  ref?: string;
  ref_type?: string;
  event_name?: string;
  pull_request?: { number?: number };
  /** `owner/repo/path@ref` of the workflow file that defines the job (trustedWorkflow.ts). */
  job_workflow_ref?: string;
}

export interface OidcVerifyResult {
  ok: true;
  claims: OidcClaims;
}

export interface OidcVerifyFailure {
  ok: false;
  reason:
    | "malformed"
    | "unsupported-alg"
    | "unknown-key"
    | "bad-signature"
    | "wrong-issuer"
    | "wrong-audience"
    | "expired"
    | "not-yet-valid"
    | "jwks-unavailable";
}

export type OidcVerifyOutcome = OidcVerifyResult | OidcVerifyFailure;

function base64UrlToBytes(input: string): Uint8Array {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((input.length + 3) % 4);
  const bin = atob(padded);
  const buf = new ArrayBuffer(bin.length);
  const out = new Uint8Array(buf);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

function base64UrlToJson<T>(input: string): T | null {
  try {
    return JSON.parse(new TextDecoder().decode(base64UrlToBytes(input))) as T;
  } catch {
    return null;
  }
}

/**
 * fetchJwks throws for a network rejection, timeout, non-2xx JWKS response,
 * invalid JSON, and repeat calls inside the post-failure cooldown. That is a
 * transient upstream problem rather than a bad token, so tag it instead of
 * letting the throw escape verifyOidc's no-throw contract and become an opaque 500.
 */
async function loadJwks(
  url: string,
  now: number,
  fetchImpl: typeof fetch,
  options?: FetchJwksOptions,
): Promise<JsonWebKey[] | null> {
  try {
    return await fetchJwks(url, now, fetchImpl, options);
  } catch {
    return null;
  }
}

/**
 * Verify a GitHub Actions OIDC token against the JWKS at `jwksUrl`. Returns a
 * tagged result instead of throwing: callers can map failure reasons to
 * specific HTTP statuses without try/catch flow. Undecodable signatures are
 * malformed; failed or throwing cryptographic verification is bad-signature.
 */
export async function verifyOidc(
  token: string,
  jwksUrl: string,
  now: number,
  fetchImpl: typeof fetch = fetch,
): Promise<OidcVerifyOutcome> {
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  const [rawHeader, rawPayload, rawSig] = parts;
  const header = base64UrlToJson<{ alg?: unknown; kid?: unknown }>(rawHeader);
  const payload = base64UrlToJson<OidcClaims>(rawPayload);
  if (!header || !payload) return { ok: false, reason: "malformed" };
  if (header.alg !== "RS256") return { ok: false, reason: "unsupported-alg" };
  if (typeof header.kid !== "string" || header.kid.length === 0) {
    return { ok: false, reason: "unknown-key" };
  }

  const keys = await loadJwks(jwksUrl, now, fetchImpl);
  if (keys === null) return { ok: false, reason: "jwks-unavailable" };
  let match = keys.find((k) => k.kid === header.kid);
  if (!match) {
    const refreshedKeys = await loadJwks(jwksUrl, now, fetchImpl, {
      bypassCacheOnKidMiss: true,
    });
    // A failed miss refresh cannot rule the kid out, so it is unavailable
    // rather than unknown.
    if (refreshedKeys === null) return { ok: false, reason: "jwks-unavailable" };
    match = refreshedKeys.find((k) => k.kid === header.kid);
  }
  if (!match) return { ok: false, reason: "unknown-key" };

  let signature: Uint8Array;
  try {
    signature = base64UrlToBytes(rawSig);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  try {
    const key = await importRs256Jwk(match);
    const signed = new TextEncoder().encode(`${rawHeader}.${rawPayload}`);
    const ok = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      signature.buffer as ArrayBuffer,
      signed.buffer as ArrayBuffer,
    );
    if (!ok) return { ok: false, reason: "bad-signature" };
  } catch {
    return { ok: false, reason: "bad-signature" };
  }

  if (payload.iss !== ISSUER) return { ok: false, reason: "wrong-issuer" };
  if (payload.aud !== AUDIENCE) return { ok: false, reason: "wrong-audience" };
  const expMs = payload.exp * 1000;
  if (!Number.isFinite(expMs) || expMs <= now) return { ok: false, reason: "expired" };
  // nbf/iat sanity: reject tokens dated in the future, allowing small skew
  // between GitHub's clock and ours.
  const skewMs = 60_000;
  if (typeof payload.nbf === "number" && payload.nbf * 1000 > now + skewMs) {
    return { ok: false, reason: "not-yet-valid" };
  }
  if (typeof payload.iat === "number" && payload.iat * 1000 > now + skewMs) {
    return { ok: false, reason: "not-yet-valid" };
  }

  return { ok: true, claims: payload };
}
