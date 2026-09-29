import { handleAdminKeys } from "./admin/handleAdminKeys.ts";
import { handleAdminRepos } from "./admin/handleAdminRepos.ts";
import { handleAdminUsage } from "./admin/handleAdminUsage.ts";
import type { ReviewWorkerEnv } from "./env.ts";
import { jsonError } from "./jsonError.ts";
import { walkthroughOrigin } from "./walkthroughOrigin.ts";
import { landingPage } from "./landingPage.ts";
import { handleMetrics } from "./metrics/handleMetrics.ts";
import { handlePlan } from "./plan/handlePlan.ts";
import { handleAnthropic } from "./proxy/handleAnthropic.ts";
import { handleSessions } from "./sessions/handleSessions.ts";
import { handleWalkthroughs, pruneReviewData } from "./walkthroughs/handleWalkthroughs.ts";

export type { ReviewWorkerEnv } from "./env.ts";

export interface ReviewWorkerDeps {
  jwksUrl: string;
  anthropicBaseUrl: string;
  fetchUpstream: typeof fetch;
  now: () => number;
  waitUntil: (promise: Promise<unknown>) => void;
}

export interface ReviewWorkerCtx {
  waitUntil?: (promise: Promise<unknown>) => void;
}

const DEFAULT_JWKS_URL = "https://token.actions.githubusercontent.com/.well-known/jwks";
const DEFAULT_ANTHROPIC = "https://api.anthropic.com";
const WALKTHROUGH_NOT_FOUND_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Walkthrough not found</title>
  </head>
  <body>
    <main>
      <h1>Walkthrough not found</h1>
      <p>This smithers review walkthrough is no longer available.</p>
    </main>
  </body>
</html>`;

function defaultDeps(ctx?: ReviewWorkerCtx): ReviewWorkerDeps {
  return {
    jwksUrl: DEFAULT_JWKS_URL,
    anthropicBaseUrl: DEFAULT_ANTHROPIC,
    // Bound, not a bare reference: workerd's fetch throws "Illegal
    // invocation" when called through a stored property (unbound `this`).
    fetchUpstream: fetch.bind(globalThis),
    now: () => Date.now(),
    waitUntil: ctx?.waitUntil
      ? (p: Promise<unknown>) => {
          ctx.waitUntil!(p);
        }
      : (p: Promise<unknown>) => {
          // No ctx.waitUntil (non-Worker caller): still surface background
          // failures instead of dropping them silently.
          p.catch((err) => console.error("smithers-review: background task failed", String(err)));
        },
  };
}

/**
 * Build a worker module object with explicit deps. The default export uses
 * production deps (real GitHub JWKS, real api.anthropic.com); tests construct
 * a handler with fixture URLs, a captured fetch, and a controllable clock.
 */
export function createReviewWorker(overrides?: Partial<ReviewWorkerDeps>) {
  return {
    async scheduled(_event: unknown, env: ReviewWorkerEnv): Promise<void> {
      try {
        const counts = await pruneReviewData(env, overrides?.now?.() ?? Date.now());
        console.info("smithers-review: retention complete", counts);
      } catch (error) {
        console.error("smithers-review: retention failed", error);
        throw error;
      }
    },
    async fetch(request: Request, env: ReviewWorkerEnv, ctx?: ReviewWorkerCtx): Promise<Response> {
      const deps: ReviewWorkerDeps = { ...defaultDeps(ctx), ...overrides };
      const url = new URL(request.url);
      const origin = url.origin;
      const contentOrigin = walkthroughOrigin(env);
      const isContentHost = contentOrigin !== null && new URL(contentOrigin).hostname === url.hostname.replace(/\.$/, "");
      const isWalkthrough = request.method === "GET" && /^\/w\/[a-z0-9]{8,32}$/.test(url.pathname);
      if (
        (url.pathname.startsWith("/w/") && (!isWalkthrough || url.origin !== contentOrigin)) ||
        (isContentHost && (!isWalkthrough || url.origin !== contentOrigin))
      ) return new Response("Not found", { status: 404 });

      if (request.method === "GET" && url.pathname === "/") {
        return new Response(landingPage, { headers: { "content-type": "text/html; charset=utf-8" } });
      }

      // Hosted artifacts do not need a database read.
      if (isWalkthrough) {
        if (!env.WALKTHROUGHS) return jsonError(503, "walkthrough storage unavailable");
        const id = url.pathname.slice("/w/".length);
        const object = await env.WALKTHROUGHS.get(`walkthroughs/${id}.html`);
        if (!object) {
          return new Response(WALKTHROUGH_NOT_FOUND_HTML, {
            status: 404,
            headers: { "content-type": "text/html; charset=utf-8" },
          });
        }
        return new Response(object.body, {
          headers: {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
            "x-robots-tag": "noindex",
            "content-security-policy": "sandbox allow-scripts",
          },
        });
      }

      // Everything below needs D1. A missing binding is a deploy/config
      // problem — answer 503 instead of crashing on an undefined dereference.
      if (!env.DB) return jsonError(503, "database unavailable");

      if (request.method === "POST" && url.pathname === "/api/sessions") {
        return handleSessions(request, env, deps, origin);
      }

      if (url.pathname.startsWith("/anthropic/")) {
        return handleAnthropic(request, env, deps, url);
      }

      if (url.pathname === "/metrics" && request.method === "GET") {
        return handleMetrics(request, env);
      }

      if (url.pathname === "/api/admin/repos") {
        return handleAdminRepos(request, env, deps.now());
      }
      if (url.pathname === "/api/admin/keys" || /^\/api\/admin\/keys\/[a-f0-9]{64}\/revoke$/.test(url.pathname)) {
        return handleAdminKeys(request, env, deps.now());
      }
      if (url.pathname === "/api/admin/usage") {
        return handleAdminUsage(request, env, deps.now());
      }

      if (url.pathname === "/api/plan" && request.method === "GET") {
        return handlePlan(request, env, url, deps.now());
      }

      if (
        (url.pathname === "/api/walkthroughs" && (request.method === "POST" || request.method === "GET")) ||
        (request.method === "DELETE" && url.pathname.startsWith("/api/walkthroughs/"))
      ) {
        if ((request.method === "POST" || request.method === "DELETE") && !env.WALKTHROUGHS) {
          return jsonError(503, "walkthrough storage unavailable");
        }
        return handleWalkthroughs(request, env, url, deps.now());
      }

      return new Response("Not found", { status: 404 });
    },
  };
}

const productionWorker = createReviewWorker();
export default productionWorker;
