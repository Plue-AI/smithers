import { mkdirSync, writeFileSync } from "node:fs";
import { REVIEW_MIGRATIONS } from "./src/server/migrations.ts";
/**
 * Alchemy 2 stack for the smithers review service. Importing it deploys nothing.
 *
 * One Cloudflare Worker (entry: src/server/worker.ts), one R2 bucket for
 * walkthroughs, one D1 database for sessions / api keys / usage / quota.
 * The Worker keeps its workers.dev URL and serves review.jjhub.tech as a
 * custom domain (the jjhub.tech zone is on this Cloudflare account).
 *
 * Plan:     pnpm -C apps/review run plan
 * Deploy:   qualified Cloud rollout only; see docs/deployment.md
 * Destroy:  pnpm -C apps/review run destroy
 * Provider operations pin `--stage prod`; state lives in the account's shared
 * `alchemy-state-store` Worker, so every machine plans against one record.
 * The physical names are the ones Alchemy 1 derived for the live resources;
 * the first Alchemy 2 plan and deploy add `--adopt` to take them over.
 *
 * Required env: CLOUDFLARE_API_TOKEN, ALCHEMY_PASSWORD, REVIEW_PUBLISH_TOKEN,
 * REVIEW_ADMIN_TOKEN, REVIEW_METRICS_TOKEN, REVIEW_ANTHROPIC_API_KEY. A deploy
 * without one fails instead of removing the live binding.
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

export const walkthroughsProps = { name: "smithers-review-walkthroughs-williamcory" };
const bucket = Cloudflare.R2.Bucket("walkthroughs", walkthroughsProps);
// Materialize the immutable SQL for Alchemy's versioned deploy-time runner.
const migrationsDir = ".alchemy/review-migrations";
mkdirSync(migrationsDir, { recursive: true });
for (const migration of REVIEW_MIGRATIONS) writeFileSync(`${migrationsDir}/${migration.name}`, migration.sql);
export const reviewDbProps = { name: "smithers-review-review-db-williamcory", migrations: migrationsDir };
const db = Cloudflare.D1.Database("review-db", reviewDbProps);

export const workerProps = {
  name: "smithers-review-smithers-review-williamcory",
  main: "src/server/worker.ts",
  compatibility: { date: "2025-05-01" },
  workersDev: true,
  observability: { enabled: true },
  env: {
    WALKTHROUGHS: bucket,
    DB: db,
    REVIEW_PUBLISH_TOKEN: requireSecret("REVIEW_PUBLISH_TOKEN"),
    ADMIN_TOKEN: requireSecret("REVIEW_ADMIN_TOKEN"),
    METRICS_TOKEN: requireSecret("REVIEW_METRICS_TOKEN"),
    ANTHROPIC_API_KEY: requireSecret("REVIEW_ANTHROPIC_API_KEY"),
    PUBLIC_BASE_URL: "https://review.jjhub.tech",
  },
  // A declared domain detaches every live hostname it does not list.
  domain: { name: "review.jjhub.tech", zoneId: "72854846f57d9e46794e7e6aae7e3328" },
  routes: [],
  crons: ["17 * * * *"],
} satisfies Cloudflare.WorkerProps;

export const worker = Cloudflare.Worker("smithers-review", workerProps);

export default Alchemy.Stack(
  "smithers-review",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  worker,
);
