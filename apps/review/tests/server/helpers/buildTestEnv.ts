import type { ReviewWorkerEnv } from "../../../src/server/env.ts";
import { REVIEW_MIGRATIONS } from "../../../src/server/migrations.ts";
import { memoryBucket } from "./memoryBucket.ts";
import { sqliteD1 } from "./sqliteD1.ts";

export interface TestEnvOverrides {
  REVIEW_PUBLISH_TOKEN?: string;
  ADMIN_TOKEN?: string;
  METRICS_TOKEN?: string;
  ANTHROPIC_API_KEY?: string;
  PUBLIC_BASE_URL?: string;
}

export async function buildTestEnv(overrides: TestEnvOverrides = {}): Promise<ReviewWorkerEnv> {
  const db = sqliteD1();
  for (const migration of REVIEW_MIGRATIONS) await db.exec(migration.sql);
  return {
    WALKTHROUGHS: memoryBucket(),
    DB: db,
    REVIEW_PUBLISH_TOKEN: overrides.REVIEW_PUBLISH_TOKEN ?? "test-publish",
    ADMIN_TOKEN: overrides.ADMIN_TOKEN ?? "test-admin",
    METRICS_TOKEN: overrides.METRICS_TOKEN ?? "test-metrics",
    ANTHROPIC_API_KEY: overrides.ANTHROPIC_API_KEY ?? "sk-ant-test",
    PUBLIC_BASE_URL: overrides.PUBLIC_BASE_URL ?? "https://content.example",
  };
}
