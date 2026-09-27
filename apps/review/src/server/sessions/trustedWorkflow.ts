/**
 * The workflow a review session's OIDC token must come from.
 *
 * On `pull_request`, GitHub runs a repository's own workflow file from the
 * pull request's merge commit, so anyone who can push a branch can edit it and
 * mint the repository's review identity. GitHub signs `job_workflow_ref`, the
 * workflow file that defines the job: for a job that calls a reusable
 * workflow it names the reusable workflow at the ref it was called at, even
 * on `pull_request`. A pull request can stop calling the trusted reusable
 * workflow, but then its token names its own file at `refs/pull/N/merge`
 * instead, and is refused.
 *
 * The rule: `job_workflow_ref` must equal one of the registration's allowed
 * refs, `owner/repo` compared ignoring case (GitHub names are
 * case-insensitive) and the workflow path and ref exactly. With none
 * configured, the only allowed ref is smithers' reusable review workflow on
 * its default branch.
 */
export const DEFAULT_TRUSTED_WORKFLOW_REF =
  "smithersai/smithers/.github/workflows/review.yml@refs/heads/main";

/**
 * An allowed ref names a workflow file under `.github/workflows` at a branch,
 * a tag or a full commit SHA. A pull request ref is never trusted: its
 * content is whatever the pull request says. A branch or tag is only as
 * trusted as the people who can move it, so an operator registers protected
 * refs only.
 */
const WORKFLOW_REF =
  /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/(\.github\/workflows\/[^@\s]+\.ya?ml)@(refs\/(?:heads|tags)\/[^\s]+|[0-9a-f]{40})$/;

interface ParsedWorkflowRef {
  repository: string;
  rest: string;
}

function parseWorkflowRef(value: string): ParsedWorkflowRef | null {
  const match = WORKFLOW_REF.exec(value);
  if (!match) return null;
  const [, owner, repo, file, ref] = match;
  return { repository: `${owner}/${repo}`.toLowerCase(), rest: `${file}@${ref}` };
}

/** True when `value` is an allowed ref an operator may register. */
export function isAllowedWorkflowRef(value: unknown): value is string {
  return typeof value === "string" && parseWorkflowRef(value) !== null;
}

/**
 * The stored `allowed_workflow_refs` column, as the refs it allows. NULL (no
 * configuration) is the default; a stored value that does not parse allows
 * nothing, so a corrupt row fails closed.
 */
export function allowedWorkflowRefs(stored: string | null): string[] {
  if (stored === null) return [DEFAULT_TRUSTED_WORKFLOW_REF];
  try {
    const parsed: unknown = JSON.parse(stored);
    if (Array.isArray(parsed) && parsed.length > 0 && parsed.every(isAllowedWorkflowRef)) return parsed;
  } catch {
    // fall through: allow nothing
  }
  return [];
}

/** Whether the token's `job_workflow_ref` claim names an allowed workflow. */
export function isTrustedWorkflow(jobWorkflowRef: unknown, allowed: readonly string[]): boolean {
  if (typeof jobWorkflowRef !== "string") return false;
  const claim = parseWorkflowRef(jobWorkflowRef);
  if (!claim) return false;
  return allowed.some((entry) => {
    const parsed = parseWorkflowRef(entry);
    return parsed !== null && parsed.repository === claim.repository && parsed.rest === claim.rest;
  });
}
