/**
 * Client for POST /api/sessions. Returns a tagged outcome:
 *   - `ok`              200 — destructured session payload
 *   - quota/spend/payment outcomes: 402 — neutral skip in the action
 *   - `unavailable`     503 after bounded retries — neutral infrastructure skip
 *   - `not-registered`  403 — neutral skip with a registration hint
 *   - `comment-mode`    409 — the repo reviews only on the magic-phrase comment
 *   - `error`           anything else (network, 5xx, …) — surfaces upstream
 *
 * The caller decides how to react: the action turns the non-200 outcomes into
 * GitHub Actions notices and exits 0 so a missing registration or a spent
 * quota does not fail the user's PR checks.
 */
export interface CreateSessionInput {
  serviceUrl: string;
  oidcToken: string;
  pr?: number;
  fetchImpl?: typeof fetch;
}

export interface SessionPayload {
  token: string;
  expiresAt: number;
  mode: "auto" | "comment";
  plan: { prsPerMonth: number; used: number };
  anthropicBaseUrl: string;
  publishUrl: string;
  /** Server-side default quiz mode; the action's `quiz` input wins over it. */
  quiz?: "off" | "auto" | "on";
  /** Optional quota detail; older servers omit it entirely. */
  quota?: { remaining?: number; limit?: number; resetsAt?: string };
}

export type SessionOutcome =
  | ({ status: "ok" } & SessionPayload)
  | { status: "quota-exhausted"; message: string }
  | { status: "repo-spend-exhausted"; message: string }
  | { status: "key-spend-exhausted"; message: string }
  | { status: "payment-required"; message: string }
  | { status: "unavailable"; message: string }
  | { status: "not-registered"; message: string }
  | { status: "untrusted-workflow"; jobWorkflowRef: string | null; allowedWorkflowRefs: string[] }
  | { status: "comment-mode" }
  | { status: "error"; message: string };

async function bodyText(res: Response): Promise<string> {
  try {
    return (await res.text()).trim();
  } catch {
    return "";
  }
}

export async function createSession(input: CreateSessionInput): Promise<SessionOutcome> {
  const base = input.serviceUrl.replace(/\/$/, "");
  const url = `${base}/api/sessions`;
  const f = input.fetchImpl ?? fetch;
  const requestBody: Record<string, unknown> = { oidcToken: input.oidcToken };
  if (typeof input.pr === "number" && input.pr > 0) requestBody.pr = input.pr;

  let res: Response;
  try {
    for (let attempt = 0; ; attempt++) {
      res = await f(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(requestBody),
      });
      if (res.status !== 503 || attempt === 2) break;
      await res.body?.cancel();
      await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
    }
  } catch (error) {
    return { status: "error", message: `request failed: ${(error as Error).message}` };
  }

  if (res.status === 503) {
    await res.body?.cancel();
    return { status: "unavailable", message: "review service unavailable; retry later" };
  }
  if (res.status === 402) {
    const raw = await bodyText(res);
    let message = raw;
    try {
      const body = JSON.parse(raw) as { error?: unknown };
      if (typeof body.error === "string") message = body.error;
    } catch { /* Older services may return plain text. */ }
    const status = message === "api key spend cap exhausted" ? "key-spend-exhausted"
      : message === "repo monthly spend cap exhausted" ? "repo-spend-exhausted"
      : /^(?:monthly )?PR quota exhausted$/.test(message) ? "quota-exhausted"
      : "payment-required";
    return { status, message: message || "review service payment required" };
  }
  if (res.status === 403) {
    const raw = await bodyText(res);
    try {
      const body = JSON.parse(raw) as { error?: unknown; jobWorkflowRef?: unknown; allowedWorkflowRefs?: unknown };
      if (body.error === "oidc: untrusted workflow") {
        return {
          status: "untrusted-workflow",
          jobWorkflowRef: typeof body.jobWorkflowRef === "string" ? body.jobWorkflowRef : null,
          allowedWorkflowRefs: Array.isArray(body.allowedWorkflowRefs)
            ? body.allowedWorkflowRefs.filter((ref): ref is string => typeof ref === "string")
            : [],
        };
      }
    } catch { /* Older services may return plain text. */ }
    return { status: "not-registered", message: raw || "repository not registered" };
  }
  if (res.status === 409) return { status: "comment-mode" };
  if (!res.ok) {
    const detail = await bodyText(res);
    return {
      status: "error",
      message: `service returned HTTP ${res.status}${detail ? ` — ${detail.slice(0, 200)}` : ""}`,
    };
  }

  const payload = (await res.json()) as SessionPayload;
  return { status: "ok", ...payload };
}
