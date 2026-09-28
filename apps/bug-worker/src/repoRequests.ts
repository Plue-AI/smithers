import { parseAppUrl } from "./appUrl.ts";
import { checkRateLimit, clientAddress, PUBLIC_READS_PER_HOUR } from "./checkRateLimit.ts";
import type { BugWorkerDeps } from "./deps.ts";
import type { BugWorkerEnv } from "./env.ts";
import { isOperator } from "./isOperator.ts";
import { logFailure } from "./logFailure.ts";
import { newToken } from "./newToken.ts";
import { publicBaseUrl } from "./publicBaseUrl.ts";
import { readBodyBounded } from "./readBodyBounded.ts";
import type { Ready } from "./RepoCompletion.ts";
import { queueDelivery } from "./repoDelivery.ts";
import { forkRepo } from "./repoForks.ts";
import { repoName } from "./repoName.ts";
import { sendMail } from "./sendMail.ts";
import { sha256 } from "./sha256.ts";

const prefix = "repo-request:";
const cors = {
  "access-control-allow-origin": "*",
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};
const json = (status: number, body: unknown, headers = cors) => new Response(JSON.stringify(body), { status, headers });
type Repo = { name: string; url: string };
/**
 * A leaderboard entry carries the app URL published for it (null while
 * smithering), so the public list is one read. Entries written before readiness
 * was materialized have no `appUrl` field and fall back to a readiness read.
 */
type Leader = { name: string; count: number; appUrl?: string | null };
/** One key holds the ranked leaderboard with readiness, so listing costs one read at any catalog size. */
const leaderboardKey = "repo-nominations-top";
const listTop = 20;
/** Browsers reuse a list for this long; KV is eventually consistent over the same window. */
const listCache = { ...cors, "cache-control": "public, max-age=60" };
async function read<T>(env: BugWorkerEnv, key: string): Promise<T | null> {
  const value = await env.BUGS.get(key);
  return value === null ? null : JSON.parse(value) as T;
}
/** Distinct nominations recorded for a repository; one accepted POST is one nomination. */
async function nominations(env: BugWorkerEnv, name: string) {
  return Number(await env.BUGS.get(`repo-nominations:${name}`)) || 0;
}
async function publicRepo(env: BugWorkerEnv, repo: Repo, count?: number) {
  const ready = await read<Ready>(env, `repo-ready:${repo.name}`);
  return {
    ...repo,
    status: ready ? "ready" : "smithering",
    appUrl: ready?.appUrl ?? null,
    nominations: count ?? await nominations(env, repo.name),
  };
}
/**
 * The committed publication for a repository, committing `candidate` first when
 * nothing is published. The Durable Object is the only authority; KV mirrors it.
 */
async function publication(env: BugWorkerEnv, name: string, candidate?: Ready): Promise<Ready | null> {
  const answer = await env.REPO_COMPLETIONS.getByName(name).fetch(new Request("https://repo-completion/",
    candidate ? { method: "POST", body: JSON.stringify(candidate) } : {}));
  if (answer.status === 404) return null;
  if (!answer.ok) throw new Error(`Repository completion answered ${answer.status}`);
  return await answer.json() as Ready;
}
/** Rewrite the leaderboard with one repository's new count and readiness; ties break on name. */
async function rank(env: BugWorkerEnv, name: string, count: number, appUrl: string | null) {
  const leaders = (await read<Leader[]>(env, leaderboardKey) ?? []).filter((leader) => leader.name !== name);
  leaders.push({ name, count, appUrl });
  leaders.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  await env.BUGS.put(leaderboardKey, JSON.stringify(leaders.slice(0, listTop)));
}
/** Publish readiness into the materialized list; a repository outside the top entries needs no rewrite. */
async function rankReady(env: BugWorkerEnv, name: string, appUrl: string) {
  const leaders = await read<Leader[]>(env, leaderboardKey) ?? [];
  const leader = leaders.find((entry) => entry.name === name);
  if (!leader || leader.appUrl === appUrl) return;
  leader.appUrl = appUrl;
  await env.BUGS.put(leaderboardKey, JSON.stringify(leaders));
}
/** Repositories ranked by nominations, most nominated first, exact at any catalog size. */
async function mostNominated(env: BugWorkerEnv) {
  const leaders = await read<Leader[]>(env, leaderboardKey) ?? [];
  return Promise.all(leaders.map((leader) => {
    const repo = { name: leader.name, url: `https://github.com/${leader.name}` };
    if (leader.appUrl === undefined) return publicRepo(env, repo, leader.count);
    return { ...repo, status: leader.appUrl ? "ready" : "smithering", appUrl: leader.appUrl, nominations: leader.count };
  }));
}
/** Pending confirmations live for a day; the KV TTL and the stored expiry agree. */
const confirmationTtlMs = 24 * 3_600_000;
/** Confirmation attempts per recipient per hour, across all repositories. */
const confirmationsPerRecipientPerHour = 3;
/**
 * The receipt for one confirmation attempt. A failed attempt names its fault:
 * `failed` stored nothing and sent nothing, `unavailable` may have delivered,
 * `rejected` was refused by the provider.
 */
type Confirmation =
  | { outcome: "sent" | "rate_limited" | "email_not_configured" }
  | { outcome: "send_failed"; event: "repo_confirmation.failed" | "repo_confirmation.unavailable" | "repo_confirmation.rejected"; error: string };
/**
 * Consent gate: a submitted address becomes a pending confirmation token, never
 * a subscriber. Only the recipient pressing the button on the emailed link's
 * page creates the deliverable record, so a caller cannot enroll a third party.
 * The attempt is charged and the token stored before the send, so every link
 * that leaves has a record and the throttle bounds the mail a victim can be
 * sent even when the provider fails. Only an operator can submit. Never throws.
 */
async function subscribe(env: BugWorkerEnv, deps: BugWorkerDeps, name: string, email: string): Promise<Confirmation> {
  if (!env.RESEND_API_KEY || !env.NOTIFICATION_FROM) return { outcome: "email_not_configured" };
  const now = deps.now();
  const confirmToken = newToken();
  try {
    const throttleKey = `repo-confirm-throttle:${await sha256(email)}:${Math.floor(now / 3_600_000)}`;
    const attempts = Number(await env.BUGS.get(throttleKey)) || 0;
    if (attempts >= confirmationsPerRecipientPerHour) return { outcome: "rate_limited" };
    await env.BUGS.put(throttleKey, String(attempts + 1), { expirationTtl: 3600 });
    await env.BUGS.put(`repo-confirm:${confirmToken}`, JSON.stringify({ name, email, expiresAt: now + confirmationTtlMs }), { expirationTtl: confirmationTtlMs / 1000 });
  } catch (error) {
    return { outcome: "send_failed", event: "repo_confirmation.failed", error: error instanceof Error ? error.message : String(error) };
  }
  // A failed send keeps the token: an `unavailable` message may still arrive
  // and must confirm, and a `rejected` one is held by nobody until the TTL.
  const sent = await sendMail(env, deps, {
    to: email,
    subject: `Confirm your Smithers notification for ${name}`,
    text: `Someone asked Smithers to email this address once ${name} is smithered and available to everyone.\n\nIf that was you, confirm within 24 hours: ${publicBaseUrl(env)}/api/repo-requests/confirm?token=${confirmToken}\n\nIf it was not you, ignore this email and nothing more will be sent. To cancel the request: ${publicBaseUrl(env)}/api/repo-requests/cancel?token=${confirmToken}`,
    idempotencyKey: `smithers-confirm-${await sha256(confirmToken)}`,
  });
  if (sent.ok) return { outcome: "sent" };
  return { outcome: "send_failed", event: `repo_confirmation.${sent.kind}`, error: sent.error };
}
const tokenPattern = /^[0-9a-f]{32}$/;
/**
 * Emailed links only open this page. Mail scanners prefetch every link in an
 * inbound message, so a GET that confirmed or cancelled would act without the
 * recipient; only the POST from this page's button touches the token.
 */
function tokenPage(route: "/confirm" | "/cancel", token: string): Response {
  if (!tokenPattern.test(token)) return json(400, { error: "A valid link token is required." });
  const label = route === "/confirm" ? "Confirm notification" : "Cancel notification";
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${label}</title>`
      + `<form method="post" action="/api/repo-requests${route}?token=${token}"><button type="submit">${label}</button></form>`,
    { status: 200, headers: {
      "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer",
      "content-security-policy": "default-src 'none'; form-action 'self'; frame-ancestors 'none'",
    } },
  );
}
/**
 * Move a pending address into the deliverable set. The token is single-use and
 * consumed last, so a storage failure answers 503 and the same link retries.
 */
async function confirmSubscription(env: BugWorkerEnv, deps: BugWorkerDeps, token: string): Promise<Response> {
  if (!tokenPattern.test(token)) return json(400, { error: "A confirmation token is required." });
  const key = `repo-confirm:${token}`;
  const pending = await read<{ name: unknown; email: unknown; expiresAt: unknown }>(env, key);
  if (!pending) return json(410, { error: "This confirmation link is invalid or has already been used." });
  if (typeof pending.name !== "string" || typeof pending.email !== "string" || typeof pending.expiresAt !== "number" || deps.now() > pending.expiresAt) {
    await env.BUGS.delete(key);
    return json(410, { error: "This confirmation link has expired." });
  }
  const cancelToken = newToken();
  const subscriberKey = `repo-subscriber:${pending.name}:${await sha256(pending.email)}`;
  await env.BUGS.put(subscriberKey, JSON.stringify({ email: pending.email, cancel: cancelToken }));
  await env.BUGS.put(`repo-cancel:${cancelToken}`, JSON.stringify({ key: subscriberKey }));
  // A signup that confirms after completion has nothing else to wake it, so the
  // repository joins the queue instead of waiting for the scan to reach it.
  if (await env.BUGS.get(`repo-ready:${pending.name}`) !== null) await queueDelivery(env, pending.name);
  await env.BUGS.delete(key);
  return json(200, { repo: pending.name, subscribed: true, cancel: `${publicBaseUrl(env)}/api/repo-requests/cancel?token=${cancelToken}` });
}
/**
 * Remove a pending confirmation or a confirmed subscription. The subscriber
 * goes before its token, so a storage failure answers 503 and the link retries.
 */
async function cancelSubscription(env: BugWorkerEnv, token: string): Promise<Response> {
  if (!tokenPattern.test(token)) return json(400, { error: "A cancellation token is required." });
  const pendingKey = `repo-confirm:${token}`;
  if (await env.BUGS.get(pendingKey) !== null) {
    await env.BUGS.delete(pendingKey);
    return json(200, { cancelled: true });
  }
  const cancelKey = `repo-cancel:${token}`;
  const cancel = await read<{ key: unknown }>(env, cancelKey);
  if (!cancel || typeof cancel.key !== "string") return json(404, { error: "This cancellation link is invalid or has already been used." });
  await env.BUGS.delete(cancel.key);
  await env.BUGS.delete(cancelKey);
  return json(200, { cancelled: true });
}
export async function handleRepoRequests(request: Request, env: BugWorkerEnv, deps: BugWorkerDeps): Promise<Response> {
  try {
    const url = new URL(request.url);
    const route = url.pathname.slice("/api/repo-requests".length);
    if (request.method === "GET" && route === "") {
      // Public reads are throttled on their own bucket so a list refresh never
      // spends the nomination budget, and abuse cannot amplify into KV reads.
      if (!(await checkRateLimit(env, `repos-read:${clientAddress(request)}`, deps.now(), PUBLIC_READS_PER_HOUR))) {
        return json(429, { error: "Too many requests. Please try again later." });
      }
      const query = url.searchParams.get("repo");
      if (query === null) return json(200, { repos: await mostNominated(env) }, listCache);
      const name = repoName(query);
      if (!name) return json(400, { error: "Enter a GitHub repository URL or owner/repo." });
      const repo = await read<Repo>(env, `${prefix}${name}`);
      if (!repo) return json(404, { error: "Repository has not been requested." });
      return json(200, { repo: await publicRepo(env, repo) });
    }
    if (route === "/confirm" || route === "/cancel") {
      const token = url.searchParams.get("token") ?? "";
      if (request.method === "GET") return tokenPage(route, token);
      if (request.method !== "POST") return json(404, { error: "Not found." });
      // Awaited so a storage failure reaches the catch below, never an unhandled rejection.
      return await (route === "/confirm" ? confirmSubscription(env, deps, token) : cancelSubscription(env, token));
    }
    const admin = route === "/complete" || route === "/notify";
    if (request.method !== "POST" || (route !== "" && !admin)) return json(404, { error: "Not found." });
    // Every write is operator-only: a nomination forks into smithers-community and
    // mails the submitted address, and no product surface submits one.
    if (!(await isOperator(request, env))) return json(401, { error: "Admin authentication required." });
    const raw = await readBodyBounded(request, 4096);
    if (raw === null) return json(413, { error: "Request is too large." });
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(raw);
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
    } catch { return json(400, { error: "Send a JSON object." }); }
    const name = repoName(body.repo);
    if (!name) return json(400, { error: "Enter a GitHub repository URL or owner/repo." });
    let repo = await read<Repo>(env, `${prefix}${name}`);
    if (admin) {
      if (!repo) return json(404, { error: "Repository has not been requested." });
      let candidate: Ready | undefined;
      if (route === "/complete") {
        const appUrl = parseAppUrl(String(body.appUrl));
        if (!appUrl) return json(400, { error: "Use an HTTPS URL on a Smithers app domain." });
        candidate = { appUrl: appUrl.href, completedAt: new Date(deps.now()).toISOString() };
      }
      const ready = await publication(env, name, candidate);
      if (!ready) return json(409, { error: "Repository is still smithering." });
      if (candidate && ready.appUrl !== candidate.appUrl) return json(409, { error: "This repository already has a published app URL." });
      // Mirror the committed record for public reads and scheduled delivery on
      // every success, so a retry or /notify repairs a lost or corrupt mirror.
      await env.BUGS.put(`repo-ready:${name}`, JSON.stringify(ready));
      await rankReady(env, name, ready.appUrl);
      // Publishing and delivery are separate: the request only queues the
      // repository and the scheduled sweep sends, so provider latency or
      // failure never reaches this response or undoes readiness.
      await queueDelivery(env, name);
      const delivery = env.RESEND_API_KEY && env.NOTIFICATION_FROM ? "queued" : "email_not_configured";
      return json(200, { repo: { ...repo, status: "ready", appUrl: ready.appUrl }, delivery });
    }
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    if ((body.email !== undefined && typeof body.email !== "string") || (email && (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)))) {
      return json(400, { error: "Enter a valid email address or leave it blank." });
    }
    if (!repo) {
      let response: Response;
      try {
        response = await deps.fetch(`https://api.github.com/repos/${name}`, {
          // Authenticated: the anonymous 60/hour quota is per source IP, and Workers share egress IPs.
          headers: {
            accept: "application/vnd.github+json",
            "user-agent": "Smithers-repo-requests",
            ...(env.GITHUB_FORK_TOKEN ? { authorization: `Bearer ${env.GITHUB_FORK_TOKEN}` } : {}),
          },
          signal: AbortSignal.timeout(10_000), redirect: "manual",
        });
      } catch (error) {
        logFailure("github_check.failed", request, error);
        return json(503, { error: "Could not check GitHub. Please try again." });
      }
      // workerd refuses redirect: "error" (it throws before the request is sent, so every
      // new nomination failed with 503 in production while Bun accepted the option locally).
      // The redirect is requested manually and a 3xx answer means the repository has moved,
      // which gets the same honest refusal as a 404.
      if (response.status === 404 || (response.status >= 300 && response.status < 400)) {
        return json(400, { error: "That repository was not found. Please use a public GitHub repository." });
      }
      if (!response.ok) {
        logFailure("github_check.failed", request, `GitHub answered ${response.status}`);
        return json(503, { error: "GitHub is unavailable or rate limited. Please try again later." });
      }
      const github = await response.json() as { private?: boolean; disabled?: boolean; license?: { spdx_id?: string } };
      if (github.private !== false || github.disabled || !github.license?.spdx_id || github.license.spdx_id === "NOASSERTION") {
        return json(400, { error: "Please use a public repository with a recognized open-source license." });
      }
      // Immutable metadata and separate readiness keys prevent concurrent submissions
      // from resetting completed work. Each subscriber also has an independent key.
      repo = { name, url: `https://github.com/${name}` };
      await env.BUGS.put(`${prefix}${name}`, JSON.stringify(repo));
      await forkRepo(env, deps, name);
    }
    // A plain counter per repository: KV has no atomic increment, so two simultaneous
    // nominations can record one. That undercount is acceptable for a public tally,
    // and the leaderboard rewritten beside the counter shares the same trade-off.
    const count = await nominations(env, name) + 1;
    await env.BUGS.put(`repo-nominations:${name}`, String(count));
    const result = await publicRepo(env, repo, count);
    await rank(env, name, count, result.appUrl);
    // Consent first: the address stays a pending token, and `subscribed` only
    // means the confirmation email left; delivery starts after the recipient
    // confirms. Without provider configuration no consent email can be sent,
    // so nothing is stored. A failed confirmation never fails the nomination;
    // its fault goes to the log.
    let subscribed = false;
    let confirmation: Confirmation["outcome"] | undefined;
    if (email && result.status !== "ready") {
      const attempt = await subscribe(env, deps, name, email);
      if (attempt.outcome === "sent") subscribed = true;
      else confirmation = attempt.outcome;
      if (attempt.outcome === "send_failed") logFailure(attempt.event, request, attempt.error);
    }
    return json(200, { repo: result, subscribed, ...(confirmation ? { confirmation } : {}) });
  } catch (error) {
    logFailure("repo_request.failed", request, error);
    return json(503, { error: "Repository requests are temporarily unavailable. Please try again." });
  }
}
