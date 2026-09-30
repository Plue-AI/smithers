/**
 * Alchemy 2 stack for bug.smithers.sh. Importing it deploys nothing.
 *
 * One Cloudflare Worker (entry: src/worker.ts), a repository completion Durable
 * Object, a rate-limit Durable Object (one atomic counter per bucket), and one
 * KV namespace for bug reports and repository requests.
 * The smithers.sh zone lives on
 * this Cloudflare account (migrated from Vercel DNS 2026-06-25), so the
 * Worker serves bug.smithers.sh as a custom domain directly.
 *
 * Plan:     pnpm -C apps/bug-worker run plan
 * Deploy:   qualified Cloud rollout only; see docs/deployment.md
 * Destroy:  pnpm -C apps/bug-worker run destroy
 * Provider operations pin `--stage prod`; state lives in the account's shared
 * `alchemy-state-store` Worker, so every machine plans against one record.
 * The physical names are the ones Alchemy 1 derived for the live resources;
 * the first Alchemy 2 plan and deploy add `--adopt` to take them over.
 *
 * Required env: CLOUDFLARE_API_TOKEN, ALCHEMY_PASSWORD, BUG_ADMIN_TOKEN,
 * RESEND_API_KEY, NOTIFICATION_FROM (a verified sender) and GITHUB_FORK_TOKEN
 * (authenticates the nomination's GitHub lookup and forks nominated
 * repositories into smithers-community). A deploy without one fails instead of
 * removing the live binding.
 */
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

const requireSecret = (name: string) =>
  Config.schema(Schema.Redacted(Schema.Trim.check(Schema.isNonEmpty())), name).pipe(
    Config.map((value) => Redacted.make(Redacted.value(value).trim())),
  );
const requireText = (name: string) =>
  Config.schema(Schema.Trim.check(Schema.isNonEmpty()), name).pipe(Config.map((value) => value.trim()));
export const bugReportsProps = { title: "smithers-bug-worker-bug-reports-williamcory" };
const bugs = Cloudflare.KV.Namespace("bug-reports", bugReportsProps);

export const workerProps = {
  name: "smithers-bug-worker-smithers-bug-worker-williamcory",
  main: "src/worker.ts",
  compatibility: { date: "2025-05-01" },
  workersDev: false,
  crons: ["*/10 * * * *"],
  // Workers Logs keeps the `logFailure` JSON lines queryable by event and route.
  observability: { enabled: true, logs: { enabled: true, invocationLogs: true, persist: true } },
  env: {
    BUGS: bugs,
    REPO_COMPLETIONS: Cloudflare.DurableObject("RepoCompletion"),
    RATE_LIMITS: Cloudflare.DurableObject("RateLimiter"),
    RESEND_API_KEY: requireSecret("RESEND_API_KEY"),
    NOTIFICATION_FROM: requireText("NOTIFICATION_FROM"),
    GITHUB_FORK_TOKEN: requireSecret("GITHUB_FORK_TOKEN"),
    BUG_ADMIN_TOKEN: requireSecret("BUG_ADMIN_TOKEN"),
    PUBLIC_BASE_URL: "https://bug.smithers.sh",
  },
  // A declared domain detaches every live hostname it does not list.
  domain: { name: "bug.smithers.sh", aliases: ["bugs.smithers.sh"], zoneId: "8ebd98d2f0dc7d8db2e61f31ebc19c14" },
} satisfies Cloudflare.WorkerProps;

export const worker = Cloudflare.Worker("smithers-bug-worker", workerProps);

export default Alchemy.Stack(
  "smithers-bug-worker",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  worker,
);
