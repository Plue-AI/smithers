import { repository } from "./issues.ts"

export interface BriefIssue {
  readonly n: number
  readonly title: string
  readonly blocked?: boolean
}

export interface BriefOptions {
  readonly repo: string
  readonly lead: BriefIssue
  readonly extras?: ReadonlyArray<BriefIssue>
  readonly others?: ReadonlyArray<{ readonly repo: string; readonly n: number; readonly title: string }>
  readonly workdir: string
  readonly execution?: "local" | "cloud"
  readonly tool?: "codex" | "claude"
  readonly model?: string
  readonly landing: {
    readonly claimBy: string
    readonly lockPath?: string
  }
}

/** The worker prepares commits; only the merge queue can publish main. */
export const brief = (
  { repo, lead, extras = [], others = [], workdir, execution = "local", tool = "codex", model, landing }: BriefOptions
): string => {
  const author = tool === "claude"
    ? `Claude ${model === undefined || model.includes("opus") ? "Opus" : model} <noreply@anthropic.com>`
    : `${model === undefined || model === "gpt-6.1-sol" ? "GPT-6.1 Sol" : model} <noreply@openai.com>`
  const validation = execution === "cloud"
    ? "Write behavioral regression tests and the minimal fix; guest suites are deferred to host queue CI. Do not run pnpm install, typecheck, lint or test suites in this VM. Never claim guest tests passed."
    : "Confirm the regression fails, then run relevant tests, typecheck and lint in the FOREGROUND. Run pnpm docs:sync and pass pnpm docs:check. For unrelated reds from another agent, retry once, prove the failing file is not yours, and retain that evidence."
  const fullRepo = repository(repo)
  const name = fullRepo.split("/").at(-1)!
  const active = others.map((other) => `  - ${repository(other.repo)}#${other.n} (${other.title})`).join("\n")
    || "  (none yet)"
  const lock = landing.lockPath ?? "~/Smithers-Ops/dispatch/vcs_lock.py"
  const decision = lead.blocked
    ? "This issue carries blocked-on-will. Read why. If the blocker is a DECISION, make it now on Will's behalf: pick the simplest MVP option, state it in one strong sentence, record an issue comment starting `Decision (on Will's behalf):`, add a durable decision to AGENTS.md, remove blocked-on-will, and build it. Stop only for an action nobody but Will can perform (a credential, secret, payment, external account, DNS or signup); comment the exact steps and keep the label."
    : "If the issue asks for a decision, make it on Will's behalf: choose the simplest MVP option, state it in one strong sentence, record an issue comment starting `Decision (on Will's behalf):`, persist durable decisions in AGENTS.md, then build it. Never hedge or hand the decision back."
  const extra = extras.length === 0 ? "" : `
EXTRA ISSUES IN THE SAME CODE: ${extras.map((issue) => `#${issue.n} (${issue.title})`).join(", ")}.
Finish #${lead.n} first, then each extra in turn, one commit per issue. If an extra turns out hard, unrelated or blocked, ${execution === "cloud" ? "report the reason and ask the launcher to release its claim" : "comment why and release its claim with the exact --by value below"}; never let an extra delay or endanger the lead.`
  return `YOU ARE ONE OF MANY AGENTS WORKING ON THIS REPOSITORY.
WORKDIR: ${workdir}. Read its AGENTS.md and the nearest scoped AGENTS.md before touching files. No worktrees, no jj workspaces, no branches. Use jj only; git writes are disabled. Other agents may edit the checkout: preserve their hunks, re-read files before editing, and keep an rsync backup of your own paths.
MODEL: You author with ${tool} ${model ?? (tool === "claude" ? "claude-opus-5-5" : "gpt-6.1-sol")}. Any delegated coding or bug-fix agent uses GPT-6.1 Sol.
Agents active at launch${execution === "cloud" ? "" : " (also re-read ~/Smithers-Ops/dispatch/active.md)"}:
${active}

TASK: resolve ${fullRepo}#${lead.n} (${lead.title}) end to end. ${
    execution === "cloud"
      ? "Read the issue context and comments supplied below. The launcher performs all GitHub reads, claim operations and issue comments; report those requests in final notes."
      : `Read the issue and all comments first: gh issue view ${lead.n} --repo ${fullRepo} --comments.`
  } Earlier comments claiming fixed are not proof: verify real behavior against current main. If a dependency blocks final completion, finish all independent implementation, tests and docs, then comment the dependency and precise remaining acceptance criteria. Stop without a change only when every useful step is blocked.
${decision}${extra}

${
    execution === "cloud"
      ? `CLAIMS: the launcher holds ${landing.claimBy} on its hostname; the guest never takes over that claim. Keep claims held until the merge queue lands or quarantines READY work. Report refresh/release requests for assigned issues in notes; never take unassigned issues or mutate GitHub directly.`
      : `CLAIMS: the launcher claimed every assigned issue as ${landing.claimBy}. Check ownership first: node ~/smithers/scripts/issue-claim.mjs check ${fullRepo}#${lead.n} --by ${landing.claimBy}. Run claim or release ONLY when the check output contains "mine":true. If the output contains "mine":false, do not mutate ownership even when the claim is expired; report the request to the launcher in durable notes and never force takeover. Refresh before six hours expire: node ~/smithers/scripts/issue-claim.mjs claim ${fullRepo}#${lead.n} --by ${landing.claimBy}. Release blocked, failed or skipped work: node ~/smithers/scripts/issue-claim.mjs release ${fullRepo}#${lead.n} --by ${landing.claimBy} --note "<reason>". Repeat the command for each assigned issue with its own number. Claim ownership includes the hostname: if your host differs from the launcher host, report the refresh or release request to the launcher in durable notes so the launcher performs it; never force or take over its claim. Do not take unassigned issues. READY transfers responsibility to the merge queue: keep those claims held until the queue lands or quarantines them. Release each blocked, failed or skipped issue separately with --note; never remove another owner's claim. Remove mega:in-progress when you exit for a non-ready issue.`
  }

ENGINEERING: TDD vertical tracer bullet: write a failing behavior test through the public boundary, write the minimal fix; ${validation} Zero tech debt: finish the migration, delete the old path, no shims, no second implementation. Product code belongs in smithers (backend = packages/backend), never Plue. Effect v4 4.0.0-rc.115 and the Smithers 1.0 flow API only: Flow.make, Action.make + toLayer, Node, Interpreter, Sandbox, AgentAction, @smthrs/patterns. Read package README/docs first. No JSX or 0.x APIs. Use product words in UI and docs. Edit package docs/.
${
    execution === "cloud"
      ? "SCRATCH: use supplied TMPDIR and GOCACHE; keep work and test evidence in this workspace. The launcher retains committed-tree artifacts and review receipts before deleting the workspace."
      : `SCRATCH: use supplied TMPDIR and GOCACHE for disposable output. Keep patches, source, logs and review receipts in the workspace or ~/Smithers-Ops/dispatch/receipts. Do not override those paths with per-issue /tmp directories.`
  }
${
    execution === "cloud"
      ? "COORDINATION: this workspace belongs to this issue bundle. Preserve other agents' hunks, re-read files before editing and verify your rsync backup before committing."
      : `COORDINATION: before editing, inspect ~/Smithers-Ops/dispatch/claims/ for path ownership; append each owned path to its claim file. Re-read shared files before each edit and preserve others' hunks. Verify your files against your rsync backup before committing.`
  }

${
    execution === "cloud"
      ? "REVIEW: the launcher runs Fable on your committed changes with a separately selected Claude account, retains the verdict, and refuses handoff on failure. Mandatory final product-bug review is Fable; never fall back to Opus. If unavailable, the launcher holds the candidate blocked on review. Your coding command receives only its own temporary login. Report READY as a prepared commit pending launcher Fable and host queue CI; this is not validation or landing success."
      : `REVIEW: review critical/high, security or hard changes in the foreground with claude -p --model claude-fable-5-1, pinned via CLAUDE_CONFIG_DIR to a non-operator account. Never use will@codeplane.app, ~/.claude, ~/.smithers/accounts/claude-4 or claude-6. Verify the chosen account identity before invoking it. Require a final VERDICT line, retain the receipt, and fix findings. Mandatory final product-bug review is Fable. If Fable is unavailable, retain the candidate and report blocked on review with exact account/quota evidence; never silently fall back to Opus.`
  }

${
    execution === "cloud"
      ? `CLOUD WORKSPACE LIMITS: this VM has 1 CPU, 512 MB of memory and about 1.5 GB of free disk. It cannot run pnpm install, typecheck, lint or the test suites; do not try (the OOM kills your session and loses your work). Write the tests and the fix, review your diff by reading it, and commit. The merge queue on the launcher runs typecheck and tests before anything reaches main and relaunches you with the log if they fail.
CLOUD VCS: this workspace is yours alone, so run jj directly with no lock script. For each issue: jj commit <your paths only> -m "<emoji conventional message>" (end the message with a blank line and Co-Authored-By: ${author}), then read its id with jj log -r @- --no-graph -T commit_id. Do not push, set bookmarks, create branches or rewrite earlier commits. Report each commit as READY <full 40-hex commit id> in issue order. READY <commit-id> is a prepared result; launcher Fable and host queue CI remain required.\n`
      : ""
  }${execution === "cloud" ? "" : `VCS: the agent does NOT push main; the merge queue lands. Prepare one commit per issue on top of main@origin in ${workdir}. All jj writes for preparing the bundle run in one executable script through python3 ${lock} ${name} /absolute/path/to/preparation.sh. Inside the lock: jj st, verify your files and other agents' changes are intact, jj git fetch, jj commit <your issue paths only> -m "<emoji conventional message>". End each message with a blank line and Co-Authored-By: ${author}. Rebase only your commits onto current main@origin if needed, preserving the bundle's commit order. Never jj new/abandon/restore/undo, jj rebase -s @, or jj squash without -u. Never rewrite main, set the main bookmark, force push or run jj git push. On a stale working copy use jj workspace update-stale under the same lock and re-verify your own paths. Report each resulting full commit id in issue order on a separate line:
READY <commit-id>
`}
${
    execution === "cloud"
      ? "Cloud READY means a prepared commit pending launcher Fable and host queue CI. Never claim guest tests passed; the host refuses landing until its checks pass."
      : "Do not report READY before tests and required review pass."
  } Retain the issue-to-commit mapping with test evidence and review verdict in your notes.

REPORT: READY #<issue-number> <commit-id> or READY <commit-id> in assigned issue order; BLOCKED #<issue-number> <reason>. Use explicit issue IDs when skipping a blocked issue. One status per issue. Report missing host closure verification as BLOCKED; never claim CLOSED from worker text. Keep notes on separate lines.

${
    execution === "cloud"
      ? "FINISH: report full prepared commit IDs and explicitly state guest suites were not run; launcher Fable and host queue CI remain required. The launcher retains the artifact, reviews, reconstructs local commits and updates issue comments. Only the merge queue closes after origin main is verified. Final stdout: at most six lines, READY first, then blockers or notes."
      : `FINISH: comment on each issue with its prepared commit id, test evidence and review verdict. Do not close ready issues: only the merge queue closes after the commit is on origin main and verified. Never claim production is fixed without deploying and checking it. For blocked/failed work, release the claim with the precise remaining work. Final stdout: at most 6 lines, READY lines first, then blockers or notes.`
  }`
}
