import { githubRepositoryId } from "../githubRepositoryId.ts";
import { lookupRepo } from "../sessions/lookupRepo.ts";
import { allowedWorkflowRefs, isAllowedWorkflowRef } from "../sessions/trustedWorkflow.ts";
import type { ReviewWorkerEnv } from "../env.ts";
import { jsonError } from "../jsonError.ts";
import { monthKey } from "../monthKey.ts";
import { timingSafeStringEqual } from "../timingSafeStringEqual.ts";

interface UpsertBody {
  repo?: unknown;
  repositoryId?: unknown;
  ownerId?: unknown;
  mode?: unknown;
  quiz?: unknown;
  prsPerMonth?: unknown;
  spendCapUsd?: unknown;
  allowedWorkflowRefs?: unknown;
}

interface RepoListRow {
  repo: string;
  repository_id: string | null;
  owner_id: string | null;
  mode: string;
  quiz: string;
  prs_per_month: number;
  spend_cap_usd: number;
  allowed_workflow_refs: string | null;
  created_at: number;
}

interface UsageRow {
  repo: string;
  cost_usd: number;
}

interface MonthPrsRow {
  repo: string;
  c: number;
}

/**
 * POST /api/admin/repos    upsert a registration
 * GET  /api/admin/repos    list registrations with month-to-date usage
 */
export async function handleAdminRepos(request: Request, env: ReviewWorkerEnv, now: number): Promise<Response> {
  const expected = `Bearer ${env.ADMIN_TOKEN ?? ""}`;
  const got = request.headers.get("authorization") ?? "";
  if (!env.ADMIN_TOKEN || !timingSafeStringEqual(got, expected)) {
    return jsonError(401, "unauthorized");
  }
  if (request.method === "POST") {
    let body: UpsertBody;
    try {
      body = (await request.json()) as UpsertBody;
    } catch {
      return jsonError(400, "invalid JSON body");
    }
    if (typeof body.repo !== "string" || body.repo.length === 0) return jsonError(400, "repo required");
    if (body.mode !== "auto" && body.mode !== "comment") return jsonError(400, "mode must be auto|comment");
    const quiz = body.quiz === undefined ? "auto" : body.quiz;
    if (quiz !== "off" && quiz !== "auto" && quiz !== "on") return jsonError(400, "quiz must be off|auto|on");
    if (typeof body.prsPerMonth !== "number" || body.prsPerMonth <= 0) return jsonError(400, "prsPerMonth must be > 0");
    if (typeof body.spendCapUsd !== "number" || body.spendCapUsd <= 0) return jsonError(400, "spendCapUsd must be > 0");
    const repositoryId = githubRepositoryId(body.repositoryId);
    const ownerId = githubRepositoryId(body.ownerId);
    if (!repositoryId || !ownerId) return jsonError(400, "repositoryId and ownerId must be positive integer IDs");
    // Omitted keeps the stored trusted workflows, null restores the default,
    // and a list replaces them.
    if (body.allowedWorkflowRefs !== undefined && body.allowedWorkflowRefs !== null &&
        !(Array.isArray(body.allowedWorkflowRefs) && body.allowedWorkflowRefs.length > 0 &&
          body.allowedWorkflowRefs.every(isAllowedWorkflowRef))) {
      return jsonError(400, "allowedWorkflowRefs must be null or a non-empty list of owner/repo/.github/workflows/<file>@<refs/heads/…|refs/tags/…|sha>");
    }
    const existing = await lookupRepo(env.DB, body.repo);
    const repo = existing?.repo ?? body.repo.toLowerCase();
    const storedWorkflowRefs = body.allowedWorkflowRefs === undefined
      ? existing?.allowed_workflow_refs ?? null
      : body.allowedWorkflowRefs === null ? null : JSON.stringify(body.allowedWorkflowRefs);
    if ((existing?.repository_id && existing.repository_id !== repositoryId) ||
        (existing?.owner_id && existing.owner_id !== ownerId)) {
      return jsonError(409, "repository identity is already bound");
    }
    const bound = await env.DB.prepare("SELECT repo FROM repos WHERE repository_id = ?")
      .bind(repositoryId).first<{ repo: string }>();
    if (bound && bound.repo !== repo) return jsonError(409, "repository identity is already bound");
    let changed: number | undefined;
    try {
      const result = await env.DB.prepare(
        `INSERT INTO repos (repo, mode, quiz, prs_per_month, spend_cap_usd, created_at, repository_id, owner_id, allowed_workflow_refs) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(repo) DO UPDATE SET mode = excluded.mode, quiz = excluded.quiz, prs_per_month = excluded.prs_per_month, spend_cap_usd = excluded.spend_cap_usd, repository_id = excluded.repository_id, owner_id = excluded.owner_id, allowed_workflow_refs = excluded.allowed_workflow_refs
         WHERE (repos.repository_id IS NULL OR repos.repository_id = excluded.repository_id)
           AND (repos.owner_id IS NULL OR repos.owner_id = excluded.owner_id)`,
      )
        .bind(repo, body.mode, quiz, body.prsPerMonth, body.spendCapUsd, now, repositoryId, ownerId, storedWorkflowRefs)
        .run();
      changed = result.meta.changes;
    } catch (error) {
      if (error instanceof Error && error.message.includes("UNIQUE constraint failed: repos.")) {
        return jsonError(409, "repository identity is already bound");
      }
      throw error;
    }
    if (changed === 0) return jsonError(409, "repository identity is already bound");
    return Response.json(
      {
        repo: repo.toLowerCase(), repositoryId, ownerId, mode: body.mode, quiz, prsPerMonth: body.prsPerMonth,
        spendCapUsd: body.spendCapUsd, allowedWorkflowRefs: allowedWorkflowRefs(storedWorkflowRefs),
      },
      { status: 200 },
    );
  }
  if (request.method === "GET") {
    const month = monthKey(now);
    const repos = await env.DB.prepare(
      "SELECT repo, repository_id, owner_id, mode, quiz, prs_per_month, spend_cap_usd, allowed_workflow_refs, created_at FROM repos ORDER BY repo",
    ).all<RepoListRow>();
    const usage = await env.DB.prepare(
      "SELECT repo, SUM(cost_usd) AS cost_usd FROM usage_events WHERE created_at >= ? GROUP BY repo",
    )
      .bind(new Date(Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), 1)).getTime())
      .all<UsageRow>();
    const prsThisMonth = await env.DB.prepare(
      "SELECT repo, COUNT(*) AS c FROM reviewed_prs WHERE month = ? GROUP BY repo",
    )
      .bind(month)
      .all<MonthPrsRow>();
    const usageByRepo = new Map(usage.results.map((r) => [r.repo, r.cost_usd ?? 0]));
    const prsByRepo = new Map(prsThisMonth.results.map((r) => [r.repo, r.c]));
    return Response.json({
      month,
      repos: repos.results.map((r) => ({
        repo: r.repo.toLowerCase(),
        repositoryId: r.repository_id,
        ownerId: r.owner_id,
        mode: r.mode,
        quiz: r.quiz,
        prsPerMonth: r.prs_per_month,
        spendCapUsd: r.spend_cap_usd,
        allowedWorkflowRefs: allowedWorkflowRefs(r.allowed_workflow_refs),
        createdAt: r.created_at,
        usage: {
          spendUsd: usageByRepo.get(r.repo) ?? 0,
          prsThisMonth: prsByRepo.get(r.repo) ?? 0,
        },
      })),
    });
  }
  return jsonError(405, "method not allowed");
}
