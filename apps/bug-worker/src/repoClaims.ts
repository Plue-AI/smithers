import { checkRateLimit, clientAddress, PUBLIC_READS_PER_HOUR } from "./checkRateLimit.ts";
import type { BugWorkerDeps } from "./deps.ts";
import type { BugWorkerEnv } from "./env.ts";
import { isOperator } from "./isOperator.ts";
import { logFailure } from "./logFailure.ts";
import { readBodyBounded } from "./readBodyBounded.ts";
import { repoName } from "./repoName.ts";

const cors = {
  "access-control-allow-origin": "*",
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: cors });
type Claim = { login: string; email?: string; claimedAt: string };

/** GitHub login rules: 1 to 39 alphanumerics or single hyphens, no leading or trailing hyphen. */
function loginName(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 39) return null;
  const login = value.trim().replace(/^@/, "");
  return /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i.test(login) ? login : null;
}

/**
 * Maintainer claims. `POST /api/repo-claims` records who claimed a nominated
 * repository; `GET /api/repo-claims?repo=owner/repo` reads it back. Claiming
 * records the claimant and nothing else yet. Emails stay out of public responses.
 *
 * The POST is operator-only (`x-bug-admin`) until `repo.claim` ships on the
 * product Worker with GitHub OAuth proof of maintainership, per
 * `~/Desktop/smithers-factory/spec/01-auth-and-access.md` section 5. A typed
 * login from an anonymous caller proves nothing, so it is refused before any
 * KV read or write.
 */
export async function handleRepoClaims(request: Request, env: BugWorkerEnv, deps: BugWorkerDeps): Promise<Response> {
  try {
    const url = new URL(request.url);
    if (request.method === "GET") {
      // Shares the public-read bucket with GET /api/repo-requests.
      if (!(await checkRateLimit(env, `repos-read:${clientAddress(request)}`, deps.now(), PUBLIC_READS_PER_HOUR))) {
        return json(429, { error: "Too many requests. Please try again later." });
      }
      const name = repoName(url.searchParams.get("repo"));
      if (!name) return json(400, { error: "Pass ?repo=owner/repo." });
      const stored = await env.BUGS.get(`repo-claim:${name}`);
      if (stored === null) return json(404, { error: "Repository has not been claimed." });
      const { email: _email, ...claim } = JSON.parse(stored) as Claim;
      return json(200, { repo: name, ...claim });
    }
    if (request.method !== "POST") return json(404, { error: "Not found." });
    if (!(await isOperator(request, env))) return json(401, { error: "Claims open with GitHub sign-in in the app." });
    if (!(await checkRateLimit(env, `claims:${clientAddress(request)}`, deps.now()))) {
      return json(429, { error: "Too many requests. Please try again later." });
    }
    const raw = await readBodyBounded(request, 4096);
    if (raw === null) return json(413, { error: "Request is too large." });
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(raw);
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("not an object");
    } catch { return json(400, { error: "Send a JSON object." }); }
    const name = repoName(body.repo);
    if (!name) return json(400, { error: "Enter a GitHub repository URL or owner/repo." });
    const login = loginName(body.login);
    if (!login) return json(400, { error: "Enter a GitHub login." });
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    if ((body.email !== undefined && typeof body.email !== "string") || (email && (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)))) {
      return json(400, { error: "Enter a valid email address or leave it blank." });
    }
    if ((await env.BUGS.get(`repo-request:${name}`)) === null) return json(404, { error: "Repository has not been requested." });
    if ((await env.BUGS.get(`repo-claim:${name}`)) !== null) return json(409, { error: "This repository is already claimed." });
    const claim: Claim = { login, ...(email ? { email } : {}), claimedAt: new Date(deps.now()).toISOString() };
    await env.BUGS.put(`repo-claim:${name}`, JSON.stringify(claim));
    return json(200, { repo: name, login: claim.login, claimedAt: claim.claimedAt });
  } catch (error) {
    logFailure("repo_claim.failed", request, error);
    return json(503, { error: "Repository claims are temporarily unavailable. Please try again." });
  }
}
