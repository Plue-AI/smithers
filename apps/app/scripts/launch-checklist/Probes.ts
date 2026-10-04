/*
 * Launch checklist (U7) — the shared probe vocabulary.
 *
 * Everything here is grounded in something this repo actually renders:
 *
 *  - `[data-flows]` on the app shell is the live command registry manifest
 *    (App.tsx: `controller.commands.all().map(c => c.name).join(" ")`), so
 *    "reachable by /name" is checkable from the page instead of guessed at.
 *  - `[data-flow="<name>"]` on every interactive affordance is that
 *    affordance's command name (App.tsx, ChatCards.tsx, ShellRail.tsx,
 *    ConnectorsSurface.tsx).
 *  - `textarea` is the composer; its presence next to the transcript is what
 *    "no separate landing view" means in the rendered DOM.
 *  - `/api/billing/balance` answers `{ state, allowedToStartWork, introUsd }`
 *    (packages/rpc/src/Cards.ts balance payload), so the one-time
 *    "$500 of usage on us" grant line is checkable against grant state rather
 *    than assumed.
 */
import type { ProbePage, ProbeResult } from "./Types.ts"

export const pass = (detail: string): ProbeResult => ({ status: "pass", detail })
export const fail = (detail: string): ProbeResult => ({ status: "fail", detail })
export const undecided = (detail: string): ProbeResult => ({ status: "not-testable-yet", detail })

export const verdict = (ok: boolean, detail: string): ProbeResult => (ok ? pass(detail) : fail(detail))

/** How long a first useful message may take (row A-2's own bar). */
export const FIRST_MESSAGE_BUDGET_MS = 90_000

/** How long "Escape stops foreground work" is allowed to take (row B-2's own bar). */
export const STOP_BUDGET_MS = 1_000

/**
 * A Smithers message has arrived when the transcript grew past the
 * composer-only shell. Shared with the hermetic e2e suites so a browser
 * assertion and its checklist row read the transcript by the same rule.
 */
export const hasSmithersMessage = (text: string): boolean => text.trim().length > 80

export const countOccurrences = (haystack: string, needle: string): number => {
  if (needle === "") return 0
  let count = 0
  let index = haystack.indexOf(needle)
  while (index !== -1) {
    count += 1
    index = haystack.indexOf(needle, index + needle.length)
  }
  return count
}

/** Expression source: focus the composer and clear any restored draft. */
export const FOCUS_COMPOSER = `(() => {
	const composer = document.querySelector("textarea");
	if (composer === null) return false;
	composer.focus();
	composer.select();
	return true;
})()`

/** Expression source: the command names the registry says are reachable by /name. */
export const REGISTERED_COMMANDS = `(() => {
	const shell = document.querySelector("[data-flows]");
	const names = shell === null ? "" : shell.getAttribute("data-flows") ?? "";
	return names.split(/\\s+/).filter((name) => name.length > 0);
})()`

/**
 * Expression source: every affordance a pointer can reach, as
 * `{ label, flow }`. `flow` is null when the affordance carries no command
 * name — exactly the C-1 failure.
 */
export const VISIBLE_AFFORDANCES = `(() => {
	const selector = "button, [role=button], a[href], summary";
	const visible = (element) => {
		const rect = element.getBoundingClientRect();
		if (rect.width === 0 && rect.height === 0) return false;
		const style = window.getComputedStyle(element);
		return style.visibility !== "hidden" && style.display !== "none";
	};
	return Array.from(document.querySelectorAll(selector))
		.filter(visible)
		.map((element) => ({
			label: (element.getAttribute("aria-label") ?? element.textContent ?? "").trim().slice(0, 60),
			flow: element.getAttribute("data-flow") ?? element.closest("[data-flow]")?.getAttribute("data-flow") ?? null,
		}));
})()`

/** Expression source: the reachable focus ring, walked with real Tab presses is slow — read it structurally instead. */
export const TABBABLE_FLOWS = `(() => {
	const selector = "a[href], button, textarea, input, select, [tabindex]:not([tabindex='-1'])";
	return Array.from(document.querySelectorAll(selector))
		.filter((element) => !element.hasAttribute("disabled") && element.getAttribute("tabindex") !== "-1")
		.map((element) => element.getAttribute("data-flow") ?? element.tagName.toLowerCase());
})()`

/** Expression source: does any card lead with process chrome instead of its result? */
export const CARD_LEADS = `(() => {
	/* The app renders cards as .smithers-card[data-kind] (ChatCards.tsx). */
	return Array.from(document.querySelectorAll(".smithers-card[data-kind], .card"))
		.map((card) => {
			const kind = card.getAttribute("data-kind") ?? "card";
			const lead = (card.textContent ?? "").trim().split("\\n").map((line) => line.trim()).filter((line) => line.length > 0)[0] ?? "";
			return { kind, lead: lead.slice(0, 80) };
		});
})()`

export const fetchInPage = (path: string): string =>
  `(async () => {
	const response = await fetch(${JSON.stringify(path)}, { credentials: "include" });
	const text = await response.text();
	let body = null;
	try { body = JSON.parse(text); } catch { body = null; }
	return { status: response.status, body, text: text.slice(0, 400) };
})()`

export interface SeamAnswer {
  readonly status: number
  readonly body: unknown
  readonly text: string
}

export const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined

/** Poll the page's text until `predicate` holds, or the budget runs out. */
export const waitForText = async (
  page: ProbePage,
  predicate: (text: string) => boolean,
  budgetMs: number,
  now: () => number,
  sleep: (ms: number) => Promise<void>,
  stepMs = 250
): Promise<{ readonly ok: boolean; readonly elapsedMs: number; readonly text: string }> => {
  const start = now()
  let text = await page.text()
  while (!predicate(text)) {
    if (now() - start >= budgetMs) return { ok: false, elapsedMs: now() - start, text }
    await sleep(stepMs)
    text = await page.text()
  }
  return { ok: true, elapsedMs: now() - start, text }
}

/** Type a prompt into the composer and submit it. Resolves to the transcript text as it was before sending. */
export const sendPrompt = async (page: ProbePage, prompt: string): Promise<string> => {
  const before = await page.text()
  const focused = await page.evaluate<boolean>(FOCUS_COMPOSER)
  if (focused !== true) throw new Error("the composer textarea never mounted, so no prompt could be sent")
  await page.type(prompt)
  await page.press("Enter")
  return before
}

/** The part of the transcript that arrived after `before` — the reply region. */
export const replyRegion = (before: string, after: string): string =>
  after.startsWith(before) ? after.slice(before.length) : after

/*
 * Copy bars the checklist states as absolutes. Each pattern is the row's own
 * words turned into something a rendered page can be measured against; none
 * of them invents a new product rule.
 */
export const SETUP_COPY =
  /\b(git clone|npm install|pnpm install|yarn install|clone the repo|configure your (workspace|environment))\b/i
export const CARD_COLLECTION_COPY = /\b(card number|cardholder|cvc|cvv|expiry date|payment method|billing address)\b/i
export const CHECKOUT_COPY =
  /\b(top[- ]?up|check ?out|add funds|buy credits|upgrade to pro|start (your )?free trial)\b/i
export const RATING_COPY =
  /\b(was this helpful|rate this|how did (we|i) do|thumbs (up|down)|leave feedback about this)\b/i
export const SCORE_COPY =
  /\b(score|grade|confidence:\s*\d|quality:\s*\d|\d+\s*\/\s*(10|100)\b|\d+\s*%\s*(confident|quality|match))/i
export const ERROR_STATE_COPY = /\b(something went wrong|unexpected error|failed to|error:)\b/i
export const FAKE_SUCCESS_COPY =
  /\b(i (have )?(sent|emailed|pushed|opened the pr|merged)|email sent|pushed to|pull request opened|done — (sent|pushed|merged))\b/i
export const HONEST_REFUSAL_COPY =
  /\b(can'?t (yet|do that)|cannot (yet|do that)|not (yet )?(able|connected|wired)|no (connector|access) for)\b/i
export const INTRO_GRANT_LINE = "$500 of usage on us"

/** A visible affordance whose command name is missing or unregistered. */
export interface Affordance {
  readonly label: string
  readonly flow: string | null
}

export const unnamedAffordances = (
  affordances: ReadonlyArray<Affordance>,
  registered: ReadonlyArray<string>
): ReadonlyArray<string> => {
  const known = new Set(registered)
  return affordances
    .filter((affordance) => affordance.flow === null || !known.has(affordance.flow))
    .map((affordance) => `${affordance.label || "(unlabelled)"} → ${affordance.flow ?? "no data-flow"}`)
}

/** Questions Smithers asked in the reply region — the A-7 budget counts these. */
export const countQuestions = (text: string): number =>
  text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => line.endsWith("?")).length
