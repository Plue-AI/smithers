import { parseAppUrl } from "./appUrl.ts";
import type { BugWorkerDeps } from "./deps.ts";
import type { BugWorkerEnv } from "./env.ts";
import { newToken } from "./newToken.ts";
import { publicBaseUrl } from "./publicBaseUrl.ts";
import type { Ready } from "./RepoCompletion.ts";
import { sendMail } from "./sendMail.ts";
import { sha256 } from "./sha256.ts";

/**
 * Readiness email delivery. Routes only queue a repository; the scheduled
 * sweep is the one sender, so two invocations never mail the same page at
 * once and no operator request waits on the provider.
 */
type Cut = "budget" | "unavailable";

/**
 * Repositories that still owe subscriber work: a further page, a rejected or
 * cut send, or a signup that arrived after completion. The sweep spends its
 * budget here first so a pending delivery never waits behind completed
 * repositories with nothing left to send.
 */
const pendingPrefix = "repo-pending:";
/** Repositories visited per scheduled invocation, per pass. */
const sweepBatch = 2;
/** Provider rejections a recipient may receive before delivery stops for good. */
const maxNotificationAttempts = 3;
/**
 * Wall time after which a sweep starts no further send. The cron runs every
 * ten minutes (`*\/10` in alchemy.run.ts) and Cloudflare stops a Cron Trigger
 * at fifteen, so five minutes plus one ten-second send timeout ends every
 * sweep before the next one starts.
 */
export const sweepBudgetMs = 5 * 60_000;

/** Put a completed repository on the queue the next sweep drains first. */
export async function queueDelivery(env: BugWorkerEnv, name: string): Promise<void> {
  await env.BUGS.put(`${pendingPrefix}${name}`, "");
}

function log(event: string, fields: Record<string, unknown>, level: "log" | "error" = "error") {
  console[level](JSON.stringify({ event, route: "scheduled", ...fields }));
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

async function list(env: BugWorkerEnv, keyPrefix: string, cursor?: string, limit = 50) {
  if (!env.BUGS.list) throw new Error("KV listing unavailable");
  return env.BUGS.list({ prefix: keyPrefix, limit, ...(cursor ? { cursor } : {}) });
}

/** Persisted readiness must satisfy the publication contract before sending mail. */
function parseReady(value: string): Ready {
  const ready: unknown = JSON.parse(value);
  if (!ready || typeof ready !== "object" || !("appUrl" in ready) || typeof ready.appUrl !== "string"
    || !("completedAt" in ready) || typeof ready.completedAt !== "string" || !Number.isFinite(Date.parse(ready.completedAt))) {
    throw new Error("Invalid readiness record");
  }
  if (!parseAppUrl(ready.appUrl)) throw new Error("Invalid readiness app URL");
  return { appUrl: ready.appUrl, completedAt: ready.completedAt };
}

/**
 * A deliverable subscriber with its cancellation token. Confirmed subscribers
 * are `{ email, cancel }` JSON. A plain address, or JSON without a token,
 * predates the confirmation flow; it is rewritten to that shape with a fresh
 * token before any mail, so every notification carries an unsubscribe link.
 * The cancel record goes first, so a failed rewrite leaves no dead link.
 */
async function subscriber(env: BugWorkerEnv, key: string, stored: string): Promise<{ email: string; cancel: string }> {
  let email = stored;
  try {
    const parsed: unknown = JSON.parse(stored);
    if (parsed && typeof parsed === "object" && "email" in parsed && typeof parsed.email === "string") {
      if ("cancel" in parsed && typeof parsed.cancel === "string") return { email: parsed.email, cancel: parsed.cancel };
      email = parsed.email;
    }
  } catch { /* A plain address. */ }
  const cancel = newToken();
  await env.BUGS.put(`repo-cancel:${cancel}`, JSON.stringify({ key }));
  await env.BUGS.put(key, JSON.stringify({ email, cancel }));
  return { email, cancel };
}

/**
 * One page of up to 50 subscribers, with receipts, a per-recipient rejection
 * budget, and provider deduplication. An unavailable provider or the sweep
 * budget cuts the page and returns its start cursor, so the next sweep re-reads
 * it and receipts skip whoever was already sent.
 */
async function notify(env: BugWorkerEnv, deps: BugWorkerDeps, name: string, ready: Ready, deadline: number, cursor?: string) {
  const page = await list(env, `repo-subscriber:${name}:`, cursor);
  let sent = 0;
  let rejected = 0;
  let errors = 0;
  const held = (cut: Cut) => ({ sent, rejected, pending: true, cursor: cursor ?? "", cut });
  for (const key of page.keys) {
    try {
      if (await env.BUGS.get(`repo-notified:${key.name}`)) continue;
      const failureKey = `repo-notification-failure:${key.name}`;
      const failureValue = await env.BUGS.get(failureKey);
      const failure = failureValue === null ? null : JSON.parse(failureValue) as { attempts: number };
      if (failure && failure.attempts >= maxNotificationAttempts) continue;
      const stored = await env.BUGS.get(key.name);
      if (!stored) continue;
      if (deps.now() >= deadline) return held("budget");
      const { email, cancel } = await subscriber(env, key.name, stored);
      const outcome = await sendMail(env, deps, {
        to: email,
        subject: `${name} is ready in Smithers`,
        text: `You asked to be notified when ${name} was smithered. It is now supported in Smithers and available to everyone.\n\nOpen in Smithers: ${ready.appUrl}\n\nThis is the one-time notification you requested at smithers.sh.\n\nUnsubscribe: ${publicBaseUrl(env)}/api/repo-requests/cancel?token=${cancel}`,
        idempotencyKey: `smithers-ready-${await sha256(key.name)}`,
      });
      if (outcome.ok) {
        await env.BUGS.put(`repo-notified:${key.name}`, ready.completedAt);
        sent++;
      } else if (outcome.kind === "unavailable") {
        // The provider failed, not this recipient: charge nobody and retry the page.
        log("repo_notification.unavailable", { repo: name, error: outcome.error });
        return held("unavailable");
      } else {
        const attempts = (failure?.attempts ?? 0) + 1;
        const terminal = attempts >= maxNotificationAttempts;
        await env.BUGS.put(failureKey, JSON.stringify({ attempts, terminal, failedAt: new Date(deps.now()).toISOString(), error: outcome.error }));
        if (terminal) log("repo_notification.terminal", { repo: name, key: key.name, error: outcome.error });
        rejected++;
      }
    } catch (error) {
      errors++;
      log("repo_notification.failed", { repo: name, key: key.name, error: message(error) });
    }
  }
  return { sent, rejected, pending: rejected > 0 || errors > 0 || !page.list_complete, cursor: page.list_complete ? null : page.cursor ?? null };
}

/** One bounded delivery step for a repository; reports whether work remains. */
async function sweepRepo(env: BugWorkerEnv, deps: BugWorkerDeps, name: string, ready: Ready, deadline: number) {
  const cursorKey = `repo-notification-cursor:${name}`;
  const result = await notify(env, deps, name, ready, deadline, await env.BUGS.get(cursorKey) || undefined);
  // Rejected recipients are revisited after the scan wraps, never by pinning a page.
  await env.BUGS.put(cursorKey, result.cursor || "");
  log("repo_notification.swept", {
    repo: name, sent: result.sent, rejected: result.rejected, pending: result.pending, ...("cut" in result ? { cut: result.cut } : {}),
  }, "log");
  return result.pending;
}

/**
 * Drain queued deliveries first, then reconcile, within `sweepBudgetMs`.
 *
 * The queue holds only repositories that still owe subscriber work, so a bounded
 * invocation spends its budget on pending recipients rather than on idle
 * completed history. The full scan stays as a slower reconciliation pass: it
 * finds subscribers written outside the confirmation flow, and enqueues work
 * whose enqueue was lost to a KV failure. Both passes leave the queue accurate,
 * so an entry survives a cut or unfinished page and is removed once the
 * repository's subscribers are drained. The scan cursor advances only past
 * repositories this sweep visited.
 */
export async function sweepDeliveries(env: BugWorkerEnv, deps: BugWorkerDeps): Promise<void> {
  if (!env.RESEND_API_KEY || !env.NOTIFICATION_FROM) return;
  const deadline = deps.now() + sweepBudgetMs;
  const queued = await list(env, pendingPrefix, undefined, sweepBatch);
  // A cursor bounds each invocation; repeated scheduled runs visit every repo.
  const cursor = await env.BUGS.get("repo-notification-sweep") || undefined;
  const page = await list(env, "repo-ready:", cursor, sweepBatch);
  const scanned = page.keys.map((key) => key.name.slice("repo-ready:".length));
  const names = new Set([...queued.keys.map((key) => key.name.slice(pendingPrefix.length)), ...scanned]);
  const visited = new Set<string>();
  for (const name of names) {
    if (deps.now() >= deadline) break;
    visited.add(name);
    try {
      const value = await env.BUGS.get(`repo-ready:${name}`);
      // Only completed repositories are queued, so a missing record is a stale
      // read: keep the entry rather than dropping a pending delivery.
      if (value === null) continue;
      if (await sweepRepo(env, deps, name, parseReady(value), deadline)) await queueDelivery(env, name);
      else await env.BUGS.delete(`${pendingPrefix}${name}`);
    } catch (error) {
      log("repo_notification.failed", { repo: name, error: message(error) });
    }
  }
  if (scanned.every((name) => visited.has(name))) {
    await env.BUGS.put("repo-notification-sweep", page.list_complete ? "" : page.cursor || "");
  }
}
