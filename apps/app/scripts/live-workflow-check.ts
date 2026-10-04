/*
 * Live wave-11 check: workflows in the conversation, on the REAL relay.
 *
 * Drives https://canary.smithers.sh with the sanctioned persistent Playwright
 * profile (codeplanesmithers — its Cloud identity and gateway are live from
 * wave 11b), then proves the seam end to end against Smithers Cloud itself:
 *
 *   1. the watched set (the universe this seam runs in),
 *   2. POST /api/workflow/provision — provision-or-resume through the
 *      wave-11b Cloud token door; idempotent on a second call,
 *   3. no gateway credential ever reaches the browser,
 *   4. List flows through the relay — is `create-flow` really there,
 *   5. the real conversation: ask for a workflow, watch the embedded run card
 *      go live, approve if it parks, see it complete.
 *
 * An honest `no-capacity` (the pool is small — WAVE4 §4) is a PASSING truth
 * bar for steps 2–5: it is surfaced, screenshotted, and reported as itself.
 *
 * Usage: bun scripts/live-workflow-check.ts [screenshots-dir]
 */
import { mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { chromium } from "playwright"
import { resetPersistedStore } from "./live-store-reset"

const PROFILE = process.env.MULTI_E2E_PROFILE ?? join(homedir(), ".multi-e2e-profile")
const BASE = process.env.CANARY_URL ?? "https://canary.smithers.sh"
const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)
const dir = process.argv[2] ?? `reports/live-checks/${timestamp}-workflows`
mkdirSync(dir, { recursive: true })

const failures: Array<string> = []
const notes: Array<string> = []
const check = (label: string, ok: boolean, detail: string): void => {
  if (ok) console.log(`ok: ${label} — ${detail}`)
  else {
    console.error(`FAIL: ${label} — ${detail}`)
    failures.push(`${label}: ${detail}`)
  }
}
const note = (line: string): void => {
  console.log(`note: ${line}`)
  notes.push(line)
}

const context = await chromium.launchPersistentContext(PROFILE, {
  headless: true,
  viewport: { width: 1280, height: 900 }
})
const page = context.pages()[0] ?? (await context.newPage())
const consoleErrors: Array<string> = []
page.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push(message.text())
})
page.on("pageerror", (error) => consoleErrors.push(String(error)))
/*
 * "Failed to load resource: 404" says nothing about WHICH resource, and a
 * console-error bar you cannot diagnose is a bar you end up waiving. Record
 * the failing responses by URL so the note names them.
 */
const failedResponses: Array<string> = []
page.on("response", (response) => {
  if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.url()}`)
})

await page.goto(BASE, { waitUntil: "domcontentloaded" })
await page.waitForTimeout(3000)

/* ---- 0. a real signed-in session (the profile holds github.com cookies) ---- */
const sessionOf = async () =>
  page.evaluate(async () => {
    const response = await fetch("/api/user")
    return { status: response.status, body: await response.json().catch(() => null) }
  })
let session = await sessionOf()
if (typeof (session.body as { login?: unknown })?.login !== "string") {
  const signIn = page.locator("[data-flow=\"sign-in\"]").first()
  await signIn.click()
  await page.waitForURL(/canary\.smithers\.sh|github\.com/, { timeout: 30_000 })
  const authorize = page.locator("button:has-text(\"Authorize\")")
  if (await authorize.isVisible().catch(() => false)) await authorize.click()
  await page.waitForURL(/canary\.smithers\.sh/, { timeout: 30_000 })
  await page.waitForTimeout(4000)
  session = await sessionOf()
}
const login = (session.body as { login?: string })?.login
check("a real signed-in session on canary", typeof login === "string", JSON.stringify(session.body))

/* ---- 1. the watched set is the universe ---- */
const watched = await page.evaluate(async () => {
  const response = await fetch("/api/identity/watched")
  return { status: response.status, body: await response.json().catch(() => null) }
})
const watchedBody = watched.body as { selected?: Array<string> } | null
const selected = (watchedBody?.selected ?? null) as Array<string> | null
const watchedAvailable = watched.status === 200 && Array.isArray(selected)
check("the watched set reads through the app origin", watchedAvailable, `HTTP ${watched.status} ${JSON.stringify(watched.body)}`)
note(`watched: ${JSON.stringify(selected)}`)

/*
 * The repo the seam targets. The watched set is a GitHub set; a workspace
 * gateway only exists for a repo that also lives on Smithers Cloud, so prefer
 * a watched repo and let WORKFLOW_REPO override for the live proof.
 */
const requestedTarget = process.env.WORKFLOW_REPO
const target = requestedTarget ?? selected?.[0] ?? ""
const targetIsWatched = selected?.some((repo) => repo.toLowerCase() === target.toLowerCase()) ?? false
const targetAvailable = watchedAvailable && target !== "" && targetIsWatched
check("a target repo is available in the watched set", targetAvailable, target || "none")
if (!watchedAvailable) note(`workflow provisioning skipped: the identity watched-set route returned HTTP ${watched.status}`)
else if (!targetIsWatched) note(`workflow provisioning skipped: target ${target || "none"} is not in the watched set`)
note(`target repo: ${target}`)

const post = (path: string, body: unknown) =>
  page.evaluate(
    async ([url, payload]) => {
      const response = await fetch(url as string, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload)
      })
      return { status: response.status, text: await response.text() }
    },
    [path, body] as const
  )

/*
 * Every flow call names a box. The target's box is the one the app would
 * pick (RepoContext `defaultBoxBinding`): exactly one running box of the
 * repository, or WORKFLOW_BOX when the account holds several.
 */
const boxes = targetAvailable ? await page.evaluate(async (repo) => {
  const [owner = "", name = ""] = repo.split("/")
  const response = await fetch(`/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/workspaces?limit=100`)
  const body = await response.json().catch(() => null) as unknown
  const record = (body ?? {}) as { workspaces?: unknown; items?: unknown }
  const rows = Array.isArray(body) ? body : Array.isArray(record.workspaces) ? record.workspaces : Array.isArray(record.items) ? record.items : []
  return rows.flatMap((row) => typeof row === "object" && row !== null && typeof (row as { id?: unknown }).id === "string"
    ? [{ id: (row as { id: string }).id, status: String((row as { status?: unknown }).status) }] : [])
}, target) : []
const running = boxes.filter((row) => row.status === "running")
const box = process.env.WORKFLOW_BOX ?? (running.length === 1 ? running[0]!.id : undefined)
if (targetAvailable) note(`box: ${box ?? `none — ${running.length} running of ${boxes.length}; open one with /box.open ${target} or set WORKFLOW_BOX`}`)

if (!targetAvailable || box === undefined) {
  // A missing watched set is a deployment/authentication failure. Never turn
  // it into a misleading 400 by POSTing { repo: "" }, and never let an
  // override bypass the user's durable watched-repository authority. A
  // target with no box has nothing to run on: no call names no box.
  note("no workflow resource calls were attempted because no authorized target with a box was available")
} else {
/* ---- 2. provision-or-resume, live, through the wave-11b token door ---- */
const first = await post("/api/workflow/provision", { repo: target, workspaceId: box })
let firstBody: { status?: string; gatewayId?: string; message?: string } = {}
try {
  firstBody = JSON.parse(first.text)
} catch {
  /* stated below as the raw answer */
}
note(`provision #1 → HTTP ${first.status} ${first.text.slice(0, 240)}`)

/* ---- 3. the credential never reaches the browser ---- */
check(
  "no gateway or Cloud credential in the provision answer",
  !first.text.includes("smithers_gateway") && !first.text.includes("smithers_pat"),
  "the token stays server-side"
)

const ready = firstBody.status === "ready"
const honestUnavailable = firstBody.status === "no-capacity" ||
  // The canary account at its own workspace cap: a named state like any
  // other, and not the deployment failing.
  firstBody.status === "quota-exceeded" ||
  firstBody.status === "no-cloud-identity" ||
  firstBody.status === "provisioning"

check(
  "the provision answer is either ready or an honest named state",
  ready || honestUnavailable,
  `${firstBody.status ?? first.status}${firstBody.message === undefined ? "" : ` — ${firstBody.message}`}`
)

if (ready) {
  // §5: provision-or-resume is idempotent — a warm resume is the SAME gateway.
  const second = await post("/api/workflow/provision", { repo: target, workspaceId: box })
  const secondBody = JSON.parse(second.text) as { status?: string; gatewayId?: string }
  check(
    "provision-or-resume is idempotent (same gateway_id on re-call)",
    secondBody.status === "ready" && secondBody.gatewayId === firstBody.gatewayId,
    `${firstBody.gatewayId} → ${secondBody.gatewayId}`
  )

  /* ---- 4. List flows through the relay: is create-flow really there ---- */
  const list = await post("/api/workflow/rpc", { repo: target, procedure: "List", payload: { _tag: "flows" }, workspaceId: box })
  note(`List flows → HTTP ${list.status} ${list.text.slice(0, 400)}`)
  const listBody = JSON.parse(list.text) as { ok?: boolean; payload?: { items?: Array<{ flowId?: string }> } }
  const ids = (listBody.payload?.items ?? []).map((entry) => entry.flowId).filter(Boolean)
  check("List flows answered through the relay", listBody.ok === true, JSON.stringify(ids).slice(0, 300))
  if (ids.includes("create-flow")) {
    check("the workspace lists the stock create-flow flow", true, JSON.stringify(ids).slice(0, 300))
  } else {
    // Not a failure: discovery is a directory walk the workspace does when it
    // starts, so a cold list shows only what was on disk at boot. `Plan`
    // resolves the registry on a miss — that is the truth.
    note(`cold List flows (registry not yet resolved): ${JSON.stringify(ids)}`)
  }
} else {
  note(
    "provisioning did not reach ready — the run-card journey below is skipped and the honest state is the proof (WAVE4 §4: the pool is quota-blocked at one node)."
  )
}

/* ---- 5. the real conversation ---- */
await page.goto(BASE, { waitUntil: "domcontentloaded" })
if (process.env.WORKFLOW_KEEP !== "1") {
  /*
   * The persistent profile keeps the app's transcript across runs, so an
   * earlier run's card — or an earlier run's PROSE — would be read as this
   * one's. Wave 12 asserts what the turn renders, so a stale transcript makes
   * the assertion meaningless: start clean unless explicitly told not to.
   */
  // The store persists to OPFS (wa-sqlite) with localStorage only as the
  // fallback. Deleting those files from inside the live page cannot work —
  // the VFS holds sync access handles on them — so the clear happens at the
  // browser level with the origin closed (see live-store-reset.ts), and the
  // result is CHECKED rather than announced.
  const survivors = await resetPersistedStore(context, page, BASE)
  check(
    "the persisted transcript is genuinely cleared — this run's card and prose are this run's",
    survivors.length === 0,
    survivors.length === 0 ? "localStorage + OPFS empty" : `OPFS still holds: ${survivors.join(", ")}`
  )
}
await page.waitForTimeout(3000)

const composer = page.locator("textarea").first()
await composer.click()
await composer.fill("can you make me a smithers workflow that summarizes my open issues?")
await composer.press("Enter")

/*
 * Wave 12 §2: this account watches three repositories, so WHICH one is a
 * genuine user choice. The chooser-among-watched renders embedded and one act
 * answers it — then the create resumes on the repo the human named.
 */
let repoQuestion = 0
for (let attempt = 0; attempt < 45; attempt += 1) {
  repoQuestion = await page.locator("[data-kind=\"workflow-repo\"]").count()
  if (repoQuestion > 0) break
  if ((await page.locator("[data-kind=\"run-trace\"]").count()) > 0) break
  await page.waitForTimeout(1000)
}
/*
 * The model does not always reach for the command (it sometimes answers with
 * prose promising to open a chooser). That is worth recording, but it must not
 * decide whether §2 gets verified: the slash form is the same command through
 * the same path, so drive it directly when the sentence did not.
 */
if (repoQuestion === 0 && (await page.locator("[data-kind=\"run-trace\"]").count()) === 0) {
  note("the model answered without invoking flow.create — driving the slash form, the same command, same path")
  // The composer refuses a submit while a turn is still streaming, so let the
  // model's turn finish before driving the command.
  await page
    /*
     * The stop button is @smthrs/ui's ChatComposer control (App.tsx binds its
     * onStop to the chat.stop flow); it carries a class, never a data-flow
     * name, so its absence is what "the turn finished" looks like in the DOM.
     */
    .waitForFunction(() => document.querySelector(".sui-chat-composer-stop") === null, undefined, {
      timeout: 60_000
    })
    .catch(() => {})
  await page.waitForTimeout(2000)
  await composer.click()
  await composer.fill("/flow.create a workflow that summarizes my open issues")
  await composer.press("Enter")
  for (let attempt = 0; attempt < 30; attempt += 1) {
    repoQuestion = await page.locator("[data-kind=\"workflow-repo\"]").count()
    if (repoQuestion > 0) break
    if ((await page.locator("[data-kind=\"run-trace\"]").count()) > 0) break
    await page.waitForTimeout(1000)
  }
}
if (repoQuestion > 0) {
  await page.screenshot({ path: `${dir}/which-repo.png`, fullPage: true })
  check(
    "the which-watched-repo question renders EMBEDDED, with the composer under it",
    await composer.isVisible(),
    "workflow-repo card in the transcript, composer visible"
  )
  const choice = page.locator("[data-flow=\"flow.repo.choose\"]").first()
  const chosenText = ((await choice.textContent()) ?? "").trim()
  await choice.click()
  note(`answered the which-repo question in one act: ${chosenText}`)
}

// The turn, the tool call, the provision, and the launch all happen here.
let runCards = 0
for (let attempt = 0; attempt < 90; attempt += 1) {
  runCards = await page.locator("[data-kind=\"run-trace\"]").count()
  if (runCards > 0) break
  await page.waitForTimeout(1000)
}
await page.screenshot({ path: `${dir}/conversation.png`, fullPage: true })

const transcript = (await page.locator(".smithers-transcript").textContent()) ?? ""
if (runCards > 0) {
  check("the conversation produced an EMBEDDED run card", true, "data-kind=run-trace in the transcript")
  // The embed law: it is a card in the chat, not a takeover.
  check(
    "the composer is still visible under the card (never a takeover)",
    await composer.isVisible(),
    "composer present"
  )

  // Watch it live: approve if it parks, then wait for it to settle.
  for (let attempt = 0; attempt < 120; attempt += 1) {
    /*
     * Approve/deny are @smthrs/ui's Confirmation buttons, which name the
     * decision rather than the approval.approve flow App.tsx runs behind them.
     */
    const approve = page.locator("[data-slot=\"confirmation-action\"][data-decision=\"approve\"]").first()
    if (await approve.isVisible().catch(() => false)) {
      await page.screenshot({ path: `${dir}/approval.png`, fullPage: true })
      await approve.click()
      note("the run parked on an approval and the human's approve was clicked")
    }
    const cardText = (await page.locator("[data-kind=\"run-trace\"]").first().textContent()) ?? ""
    if (/Finished\.|Failed\.|Cancelled\./.test(cardText)) break
    await page.waitForTimeout(2000)
  }
  const cardText = (await page.locator("[data-kind=\"run-trace\"]").first().textContent()) ?? ""
  note(`run card, settled: ${cardText.replace(/\s+/g, " ").slice(0, 400)}`)
  await page.screenshot({ path: `${dir}/run-card.png`, fullPage: true })
  check(
    "the run card never sat silent — it states a phase in words",
    /Running on your workspace|Waiting for your approval|Reconnecting|Finished\.|Failed\.|Cancelled\.|No workspace capacity/
      .test(
        cardText
      ),
    cardText.replace(/\s+/g, " ").slice(0, 200)
  )
} else {
  // No card: the app must still have SAID what happened, honestly.
  note(`no run card; transcript tail: ${transcript.replace(/\s+/g, " ").slice(-500)}`)
  check(
    "without a run card the chat still states honestly what happened",
    /workspace|capacity|watch|workflow|sign in/i.test(transcript),
    transcript.replace(/\s+/g, " ").slice(-240)
  )
}

/*
 * Wave 12 §1, live: whatever the model wrote, the RENDERED turn may not claim
 * the workflow was created. This is the exact sentence canary shipped in wave
 * 11, beside a card that truthfully read Running.
 */
const finalTranscript = (await page.locator(".smithers-transcript").textContent()) ?? ""
check(
  "the rendered turn never claims the workflow was created",
  !/has been created|have been created|workflow .*is now running/i.test(finalTranscript),
  finalTranscript.replace(/\s+/g, " ").slice(-300)
)
if (runCards > 0) {
  check(
    "a launched run is described by the client's deterministic line, not the model's prose",
    /I started a create-flow run|Smithers started a create-flow run/.test(finalTranscript),
    finalTranscript.replace(/\s+/g, " ").slice(-300)
  )
}
}

check(
  "zero console errors across the workflow journey",
  consoleErrors.length === 0,
  consoleErrors.length === 0
    ? "console is clean"
    : `${consoleErrors.join(" | ").slice(0, 200)} :: ${[...new Set(failedResponses)].join(" | ").slice(0, 400)}`
)

await context.close()
console.log(`\nnotes:\n${notes.map((line) => `  - ${line}`).join("\n")}`)
if (failures.length > 0) {
  console.error(`\nWORKFLOW LIVE CHECK FAIL: ${failures.length} failure(s) — screenshots in ${dir}`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log(`\nWORKFLOW LIVE CHECK PASS: screenshots in ${dir}`)
process.exit(0)