import { walkthroughOrigin } from "../walkthroughOrigin.ts";
import { sameRepoName } from "../sameRepoName.ts";
import type { ReviewWorkerEnv } from "../env.ts";
import { jsonError } from "../jsonError.ts";
import { authenticateProxyRequest, type ProxyAuth } from "../proxy/authenticateProxyRequest.ts";
import { timingSafeStringEqual } from "../timingSafeStringEqual.ts";

const MAX_WALKTHROUGH_BYTES = 25 * 1024 * 1024;
export const MAX_PUBLISHES_PER_SESSION = 50;

// 32 chars: 256 % 32 === 0, so byte % 32 is unbiased (base-36 was not).
const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz012345";

function newWalkthroughId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => ID_ALPHABET[b % 32]).join("");
}

interface WalkthroughRow {
  id: string;
  repo: string;
  pr: number;
  bytes: number;
  created_at: number;
  status: "pending" | "complete";
}

interface WalkthroughRepoRow {
  repo: string;
}

interface PublishAttribution {
  repo: string;
  pr: number;
  sessionHash: string | null;
}

/**
 * /api/walkthroughs — store and manage hosted HTML walkthroughs.
 *
 * Publish accepts three credentials in order of preference:
 *  1. Bearer REVIEW_PUBLISH_TOKEN (service automation).
 *  2. A valid session token (action-issued, via x-api-key or Bearer).
 *  3. A valid srk_ API key (operator-issued, via x-api-key or Bearer).
 */
export async function handleWalkthroughs(
  request: Request,
  env: ReviewWorkerEnv,
  url: URL,
  now: number,
): Promise<Response> {
  if (request.method === "POST" && url.pathname === "/api/walkthroughs") {
    return handlePublish(request, env, now);
  }
  if (request.method === "GET" && url.pathname === "/api/walkthroughs") {
    return handleHistory(request, env, url, now);
  }
  if (request.method === "DELETE" && url.pathname.startsWith("/api/walkthroughs/")) {
    return handleDelete(request, env, url, now);
  }
  return jsonError(404, "not found");
}

async function handlePublish(request: Request, env: ReviewWorkerEnv, now: number): Promise<Response> {
  const base = walkthroughOrigin(env);
  if (!base) return jsonError(503, "walkthrough origin unavailable");
  const publishTokenOk = isPublishToken(request, env);
  let credential: ProxyAuth | null = null;
  if (!publishTokenOk) {
    credential = await authenticateProxyRequest(request, env, now);
    if (!credential) return jsonError(401, "unauthorized");
  }

  const html = await request.arrayBuffer();
  if (html.byteLength === 0) return jsonError(400, "empty body");
  if (html.byteLength > MAX_WALKTHROUGH_BYTES) return jsonError(413, "walkthrough exceeds 25MB");

  const attribution = publishAttribution(publishTokenOk ? null : credential);
  const id = newWalkthroughId();
  // Count and reserve in one statement so concurrent uploads cannot share a
  // session's last slot. Pending uploads count toward the limit too.
  const reservation = await env.DB.prepare(
    `INSERT INTO walkthroughs (id, repo, pr, bytes, session_hash, created_at, status)
     SELECT ?, ?, ?, ?, ?, ?, 'pending'
     WHERE ? IS NULL OR (SELECT COUNT(*) FROM walkthroughs WHERE session_hash = ?) < ?`,
  )
    .bind(id, attribution.repo, attribution.pr, html.byteLength, attribution.sessionHash, now,
      attribution.sessionHash, attribution.sessionHash, MAX_PUBLISHES_PER_SESSION)
    .run();
  if (reservation.meta.changes === 0) {
    return jsonError(429, "publish limit reached for this session");
  }

  const key = `walkthroughs/${id}.html`;
  try {
    await env.WALKTHROUGHS.put(key, html, {
      httpMetadata: { contentType: "text/html; charset=utf-8" },
    });
    const finalized = await env.DB.prepare("UPDATE walkthroughs SET status = 'complete' WHERE id = ?")
      .bind(id)
      .run();
    // DELETE may have removed the reservation while the upload was in flight.
    if (finalized.meta.changes === 0) {
      await env.WALKTHROUGHS.delete(key);
      return jsonError(409, "walkthrough deleted during upload");
    }
  } catch (error) {
    // Remove the object first. If cleanup fails, retain the durable row so an
    // authorized DELETE can retry instead of leaving an untracked R2 object.
    await env.WALKTHROUGHS.delete(key);
    await env.DB.prepare("DELETE FROM walkthroughs WHERE id = ?").bind(id).run();
    throw error;
  }
  return Response.json({ id, url: `${base}/w/${id}` }, { status: 201 });
}

async function handleHistory(request: Request, env: ReviewWorkerEnv, url: URL, now: number): Promise<Response> {
  const base = walkthroughOrigin(env);
  if (!base) return jsonError(503, "walkthrough origin unavailable");
  const credential = await authenticateProxyRequest(request, env, now);
  if (!credential) return jsonError(401, "unauthorized");

  const repo = url.searchParams.get("repo");
  if (!repo) return jsonError(400, "repo query parameter is required");
  if (!canAccessRepo(credential, repo)) return jsonError(403, "forbidden");

  const rows = await env.DB.prepare(
    "SELECT id, repo, pr, bytes, created_at, status FROM walkthroughs WHERE repo = ? COLLATE NOCASE ORDER BY created_at DESC LIMIT 50",
  )
    .bind(repo)
    .all<WalkthroughRow>();
  return Response.json({
    walkthroughs: rows.results.map((row) => ({
      id: row.id,
      repo: row.repo,
      pr: row.pr,
      bytes: row.bytes,
      createdAt: row.created_at,
      status: row.status,
      url: `${base}/w/${row.id}`,
    })),
  });
}

async function handleDelete(request: Request, env: ReviewWorkerEnv, url: URL, now: number): Promise<Response> {
  const id = url.pathname.slice("/api/walkthroughs/".length);
  if (!/^[a-z0-9]{8,32}$/.test(id)) return jsonError(400, "invalid walkthrough id");

  const publishTokenOk = isPublishToken(request, env);
  let credential: ProxyAuth | null = null;
  if (!publishTokenOk) {
    credential = await authenticateProxyRequest(request, env, now);
    if (!credential) return jsonError(401, "unauthorized");
  }

  const row = await env.DB.prepare("SELECT repo FROM walkthroughs WHERE id = ?").bind(id).first<WalkthroughRepoRow>();
  if (!row) return jsonError(404, "not found");
  if (!publishTokenOk && (!credential || !canAccessRepo(credential, row.repo))) {
    return jsonError(403, "forbidden");
  }

  await env.WALKTHROUGHS.delete(`walkthroughs/${id}.html`);
  await env.DB.prepare("DELETE FROM walkthroughs WHERE id = ?").bind(id).run();
  return Response.json({ deleted: true });
}

function publishAttribution(credential: ProxyAuth | null): PublishAttribution {
  if (!credential) return { repo: "", pr: 0, sessionHash: null };
  if (credential.kind === "session") {
    return { repo: credential.repo, pr: credential.pr, sessionHash: credential.hash };
  }
  return { repo: credential.repos[0] ?? "", pr: 0, sessionHash: null };
}

function canAccessRepo(credential: ProxyAuth, repo: string): boolean {
  if (credential.kind === "session") return sameRepoName(credential.repo, repo);
  return credential.repos.some((name) => sameRepoName(name, repo));
}

function isPublishToken(request: Request, env: ReviewWorkerEnv): boolean {
  const publishToken = env.REVIEW_PUBLISH_TOKEN ?? "";
  const auth = request.headers.get("authorization") ?? "";
  return Boolean(publishToken && timingSafeStringEqual(auth, `Bearer ${publishToken}`));
}



/** Delete expired objects before their rows so failed R2 deletes remain retryable. */
export async function pruneReviewData(env: ReviewWorkerEnv, now: number): Promise<Record<string, number>> {
  const cutoff = now - 90 * 86400000;
  const expired = await env.DB.prepare("SELECT id FROM walkthroughs WHERE created_at < ? ORDER BY created_at LIMIT 20")
    .bind(cutoff).all<{ id: string }>();
  let walkthroughs = 0;
  for (const { id } of expired.results) {
    await env.WALKTHROUGHS.delete(`walkthroughs/${id}.html`);
    await env.DB.prepare("DELETE FROM walkthroughs WHERE id = ?").bind(id).run();
    walkthroughs++;
  }
  // Keep unsettled calls and their idempotency records until reconciliation.
  const results = await env.DB.batch([
    env.DB.prepare(`DELETE FROM sessions WHERE hash IN (
      SELECT hash FROM sessions WHERE expires_at < ?
      AND NOT EXISTS (SELECT 1 FROM usage_reservations WHERE session_hash = sessions.hash) LIMIT 1000
    )`).bind(now - 86400000),
    env.DB.prepare(`DELETE FROM usage_events WHERE id IN (
      SELECT id FROM usage_events WHERE created_at < ?
      AND NOT EXISTS (SELECT 1 FROM usage_reservations WHERE id = usage_events.id) LIMIT 1000
    )`).bind(cutoff),
    env.DB.prepare(`DELETE FROM reviewed_prs WHERE rowid IN (
      SELECT rowid FROM reviewed_prs WHERE month < ? LIMIT 1000
    )`).bind(new Date(cutoff).toISOString().slice(0, 7)),
  ]);
  return { walkthroughs, sessions: results[0]?.meta.changes ?? 0, usageEvents: results[1]?.meta.changes ?? 0, reviewedPrs: results[2]?.meta.changes ?? 0 };
}
