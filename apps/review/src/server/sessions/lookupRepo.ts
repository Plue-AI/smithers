import type { D1Database } from "../d1.ts";

export interface RepoRecord {
  repo: string;
  repository_id: string | null;
  owner_id: string | null;
  mode: "auto" | "comment";
  quiz: "off" | "auto" | "on";
  prs_per_month: number;
  spend_cap_usd: number;
  /** JSON array of trusted `job_workflow_ref` values; NULL is the default (trustedWorkflow.ts). */
  allowed_workflow_refs: string | null;
  created_at: number;
}

export async function lookupRepo(db: D1Database, repo: string): Promise<RepoRecord | null> {
  const row = await db
    .prepare("SELECT repo, repository_id, owner_id, mode, quiz, prs_per_month, spend_cap_usd, allowed_workflow_refs, created_at FROM repos WHERE repo = ? COLLATE NOCASE")
    .bind(repo)
    .first<RepoRecord>();
  return row ?? null;
}
