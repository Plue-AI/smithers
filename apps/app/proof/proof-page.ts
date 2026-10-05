/**
 * The proof page model and renderer; page.ts is its command line. The proof page: one self-contained HTML file that plays like the design mock
 * (.specs/design/mock) but shows what the real app recorded. One reel per mock
 * journey, in mock order; each mock step shows its caption, the screenshot the
 * proof run recorded for the feature covering it, and a verdict.
 *
 * Inputs (EVIDENCE-CONTRACT.md): .specs/product/features.json, the Playwright
 * JSON results of playwright.proof.config.ts, and apps/app/proof/mock-steps.json
 * (read from the mock's journeys when that file is absent). Output: <out>/index.html
 * with every screenshot embedded and each journey's video copied beside it.
 * It makes no network request. No import.meta here: Playwright loads this
 * module as CommonJS from the page e2e.
 */
import { execFileSync } from "node:child_process"
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path"

export const REPOSITORY = "https://github.com/smithersai/smithers"

// ── Inputs ──────────────────────────────────────────────────────────────────

export interface ProofRef { readonly file: string; readonly step: string }

export interface Feature {
  readonly id: string
  readonly title: string
  readonly journey: string
  readonly spec?: string
  readonly mockSteps: ReadonlyArray<string>
  readonly status: "implemented" | "not-implemented"
  readonly proof: ReadonlyArray<ProofRef>
  readonly docs: ReadonlyArray<string>
  readonly code: ReadonlyArray<string>
  readonly gap?: string
}

export interface MockStep { readonly caption: string; readonly spec?: string }

/** One mock journey: `file` is the journey file name mockSteps refer to (`j1` in `j1#21`). */
export interface MockReel {
  readonly file: string
  readonly title: string
  readonly intro: string
  readonly steps: ReadonlyArray<MockStep>
}

/** The subset of Playwright's JSON report the page reads. */
export interface PwStep { readonly title: string; readonly duration?: number; readonly error?: PwError; readonly steps?: ReadonlyArray<PwStep> }
export interface PwError { readonly message?: string; readonly stack?: string; readonly value?: string }
export interface PwAttachment { readonly name: string; readonly contentType: string; readonly path?: string; readonly body?: string }
export interface PwResult {
  readonly status?: string
  readonly steps?: ReadonlyArray<PwStep>
  readonly attachments?: ReadonlyArray<PwAttachment>
  readonly errors?: ReadonlyArray<PwError>
  readonly annotations?: ReadonlyArray<{ readonly type: string; readonly description?: string }>
}
export interface PwTest { readonly results?: ReadonlyArray<PwResult>; readonly annotations?: ReadonlyArray<{ readonly type: string; readonly description?: string }> }
export interface PwSpec { readonly title: string; readonly file: string; readonly line?: number; readonly tests?: ReadonlyArray<PwTest> }
export interface PwSuite { readonly title?: string; readonly file?: string; readonly specs?: ReadonlyArray<PwSpec>; readonly suites?: ReadonlyArray<PwSuite> }
export interface PwReport {
  readonly config?: { readonly rootDir?: string; readonly metadata?: Record<string, unknown> }
  readonly suites?: ReadonlyArray<PwSuite>
  readonly stats?: { readonly startTime?: string }
}

// ── Verdicts ────────────────────────────────────────────────────────────────

export type VerdictKind = "works" | "broken" | "blocked" | "not-built"

export interface Verdict {
  readonly kind: VerdictKind
  /** Broken: the first error. Not built: what is missing. */
  readonly detail?: string
  /** Blocked: the feature whose failure stopped this one. */
  readonly blockedBy?: string
}

/** One proof step as the run recorded it. */
export interface RecordedStep {
  readonly file: string
  readonly step: string
  readonly outcome: "passed" | "failed" | "blocked"
  readonly error?: string
  readonly blockedBy?: string
}

/** Severity order: a step or reel shows its worst feature. */
export const SEVERITY: Readonly<Record<VerdictKind, number>> = { works: 0, "not-built": 1, blocked: 2, broken: 3 }

const BLOCKED = /\bblocked by ([A-Za-z0-9][\w.:-]*)/i

const errorText = (error: PwError | undefined): string | undefined => {
  if (error === undefined) return undefined
  const text = error.message ?? error.value ?? error.stack
  // Playwright colours terminal output; the page shows plain text.
  return text === undefined ? undefined : text.replace(/\u001b\[[0-9;]*m/g, "").trim()
}

/** The first error in a step's own subtree: a soft assertion records its error on a child step. */
const firstError = (step: PwStep): string | undefined => {
  const own = errorText(step.error)
  if (own !== undefined) return own
  for (const child of step.steps ?? []) {
    const found = firstError(child)
    if (found !== undefined) return found
  }
  return undefined
}

/** A proof step's title is the feature id, alone or followed by a space or colon and prose. */
export const titleNames = (title: string, id: string): boolean =>
  title === id || title.startsWith(`${id} `) || title.startsWith(`${id}:`)

/** Does a spec file as Playwright reports it (relative to its testDir) name the registry's repository path? */
export const sameFile = (reported: string, registry: string): boolean => {
  const a = reported.replace(/\\/g, "/").replace(/^\.\//, "")
  const b = registry.replace(/\\/g, "/").replace(/^\.\//, "")
  return a === b || b.endsWith(`/${a}`) || a.endsWith(`/${b}`)
}

export interface RecordedTest {
  readonly file: string
  readonly line?: number
  readonly title: string
  readonly result: PwResult
}

/** Every test's final result (the last retry), in report order. */
export const recordedTests = (report: PwReport): ReadonlyArray<RecordedTest> => {
  const out: Array<RecordedTest> = []
  const walk = (suite: PwSuite) => {
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        const results = test.results ?? []
        const result = results[results.length - 1]
        if (result === undefined) continue
        const annotations = [...(test.annotations ?? []), ...(result.annotations ?? [])]
        out.push({ file: spec.file, ...(spec.line === undefined ? {} : { line: spec.line }), title: spec.title, result: { ...result, annotations } })
      }
    }
    for (const child of suite.suites ?? []) walk(child)
  }
  for (const suite of report.suites ?? []) walk(suite)
  return out
}

const walkSteps = function* (steps: ReadonlyArray<PwStep> | undefined): Generator<PwStep> {
  for (const step of steps ?? []) {
    yield step
    yield* walkSteps(step.steps)
  }
}

/**
 * Find a proof step in the recorded run. A step is blocked when its error, or
 * a test annotation of type "blocked" naming it, says "blocked by <feature id>";
 * failed when it or any child step carries an error; passed otherwise.
 * Undefined when the run never reached a step with that title.
 */
export const findStep = (tests: ReadonlyArray<RecordedTest>, ref: ProofRef): RecordedStep | undefined => {
  for (const test of tests) {
    if (!sameFile(test.file, ref.file)) continue
    for (const step of walkSteps(test.result.steps)) {
      if (!titleNames(step.title, ref.step)) continue
      const error = firstError(step)
      const annotated = (test.result.annotations ?? []).find(each =>
        each.type.toLowerCase() === "blocked" && each.description !== undefined && titleNames(each.description, ref.step))
      const blocked = (error === undefined ? undefined : BLOCKED.exec(error)) ?? (annotated === undefined ? undefined : BLOCKED.exec(annotated.description!))
      if (blocked !== null && blocked !== undefined) return { ...ref, outcome: "blocked", blockedBy: blocked[1]! }
      if (error !== undefined) return { ...ref, outcome: "failed", error }
      return { ...ref, outcome: "passed" }
    }
  }
  return undefined
}

/**
 * The verdict rules. Works only when the feature names at least one proof step
 * and every one passed in this run. A failed step makes it Broken (with the
 * error); a step blocked by another feature makes it Blocked by that id; no
 * proof, or a step the run never recorded, makes it Not built.
 */
export const verdictOf = (feature: Feature, tests: ReadonlyArray<RecordedTest>): Verdict => {
  if (feature.proof.length === 0) return { kind: "not-built", detail: feature.gap !== undefined && feature.gap !== "" ? feature.gap : "No proof step yet." }
  const recorded = feature.proof.map(ref => ({ ref, step: findStep(tests, ref) }))
  const failed = recorded.find(each => each.step?.outcome === "failed")
  if (failed !== undefined) return { kind: "broken", detail: failed.step!.error ?? "failed" }
  const blocked = recorded.find(each => each.step?.outcome === "blocked")
  if (blocked !== undefined) return { kind: "blocked", blockedBy: blocked.step!.blockedBy! }
  const missing = recorded.find(each => each.step === undefined)
  if (missing !== undefined) return { kind: "not-built", detail: `Not recorded in this run: ${missing.ref.file} step ${missing.ref.step}.` }
  return { kind: "works" }
}

export interface Disagreement { readonly id: string; readonly status: Feature["status"]; readonly verdict: VerdictKind }

/** features.json says implemented exactly when the run says Works; anything else is a disagreement. */
export const disagreements = (features: ReadonlyArray<Feature>, verdicts: ReadonlyMap<string, Verdict>): ReadonlyArray<Disagreement> =>
  features.flatMap(feature => {
    const verdict = verdicts.get(feature.id)!.kind
    return (feature.status === "implemented") === (verdict === "works") ? [] : [{ id: feature.id, status: feature.status, verdict }]
  })

// ── Model ───────────────────────────────────────────────────────────────────

export interface StepModel {
  /** `j1#3`, 1-based like features.json's mockSteps. */
  readonly ref: string
  readonly n: number
  readonly caption: string
  readonly spec?: string
  /** Every feature covering this step, in features.json order. */
  readonly features: ReadonlyArray<string>
  /** The features this step shows in full: those whose first covered step is this one. The rest are referenced. */
  readonly home: ReadonlyArray<string>
  readonly verdict: VerdictKind
}

export interface ReelModel {
  readonly file: string
  readonly title: string
  readonly intro: string
  readonly steps: ReadonlyArray<StepModel>
  /** Features of this reel's journey that name no mock step that exists; shown on the reel's opening frame. */
  readonly unmapped: ReadonlyArray<string>
  /** Relative path of the journey test's video beside the page. */
  readonly video?: string
}

export interface FeatureModel {
  readonly id: string
  readonly title: string
  readonly journey: string
  readonly status: Feature["status"]
  readonly gap?: string
  readonly verdict: Verdict
  readonly shot?: string
  readonly tests: ReadonlyArray<{ readonly label: string; readonly href: string }>
  readonly docs: ReadonlyArray<{ readonly label: string; readonly href: string }>
  readonly code: ReadonlyArray<{ readonly label: string; readonly href: string }>
}

export interface PageModel {
  readonly sha: string
  readonly time: string
  readonly reels: ReadonlyArray<ReelModel>
  readonly features: Readonly<Record<string, FeatureModel>>
  readonly counts: { readonly works: number; readonly total: number; readonly byJourney: ReadonlyArray<{ readonly journey: string; readonly works: number; readonly total: number }> }
  readonly disagreements: ReadonlyArray<Disagreement>
  /** Mock steps features.json names that the mock does not have. */
  readonly unknownSteps: ReadonlyArray<{ readonly id: string; readonly ref: string }>
}

/** A repository path with an optional `#L10` or `#L10-L20` anchor, as a permalink at `sha`. */
export const permalink = (repository: string, sha: string, path: string): string => {
  const [file, anchor] = path.split("#", 2) as [string, string | undefined]
  return `${repository}/blob/${sha}/${file.replace(/^\/+/, "")}${anchor === undefined || anchor === "" ? "" : `#${anchor}`}`
}

export interface BuildInput {
  readonly features: ReadonlyArray<Feature>
  readonly mock: ReadonlyArray<MockReel>
  readonly report: PwReport
  readonly sha: string
  readonly time: string
  readonly repository?: string
  /** Line of a proof step in its spec file, for the permalink; undefined links to the file. */
  readonly stepLine?: (ref: ProofRef) => number | undefined
  /** The screenshot for a feature (a data: URI), if the run recorded one. */
  readonly shot?: (featureId: string, test: RecordedTest | undefined) => string | undefined
  /** The relative path of a reel's journey video beside the page, if the run recorded one. */
  readonly video?: (reel: MockReel, tests: ReadonlyArray<RecordedTest>) => string | undefined
}

const journeyKey = (text: string): string => text.trim().toLowerCase()

/** The model the page renders: pure, so the verdict rules and coverage are testable without a browser. */
export const buildModel = (input: BuildInput): PageModel => {
  const repository = input.repository ?? REPOSITORY
  const tests = recordedTests(input.report)
  const verdicts = new Map(input.features.map(feature => [feature.id, verdictOf(feature, tests)] as const))

  const known = new Set(input.mock.flatMap(reel => reel.steps.map((_, i) => `${reel.file}#${i + 1}`)))
  const unknownSteps = input.features.flatMap(feature => feature.mockSteps.filter(ref => !known.has(ref)).map(ref => ({ id: feature.id, ref })))

  /* A feature's home is the first mock step it covers, in mock order; that step shows it in full. */
  const covering = new Map<string, Array<string>>()
  for (const feature of input.features) {
    for (const ref of new Set(feature.mockSteps)) {
      if (!known.has(ref)) continue
      const list = covering.get(ref) ?? []
      list.push(feature.id)
      covering.set(ref, list)
    }
  }
  const homed = new Set<string>()
  const reels: Array<ReelModel> = input.mock.map(reel => {
    const steps = reel.steps.map((step, i): StepModel => {
      const ref = `${reel.file}#${i + 1}`
      const features = covering.get(ref) ?? []
      const home = features.filter(id => !homed.has(id))
      for (const id of home) homed.add(id)
      const verdict = features.length === 0 ? "not-built"
        : features.map(id => verdicts.get(id)!.kind).reduce((worst, kind) => SEVERITY[kind] > SEVERITY[worst] ? kind : worst, "works" as VerdictKind)
      return { ref, n: i + 1, caption: step.caption, ...(step.spec === undefined ? {} : { spec: step.spec }), features, home, verdict }
    })
    const video = input.video?.(reel, tests)
    return { file: reel.file, title: reel.title, intro: reel.intro, steps, unmapped: [], ...(video === undefined ? {} : { video }) }
  })

  /* Features with no mock step that exists open their journey's reel; a journey with no reel gets one. */
  const reelByJourney = new Map(reels.map((reel, index) => [journeyKey(reel.file), index] as const))
  const orphans: Array<string> = []
  for (const feature of input.features) {
    if (homed.has(feature.id)) continue
    homed.add(feature.id)
    const index = reelByJourney.get(journeyKey(feature.journey))
    if (index === undefined) orphans.push(feature.id)
    else reels[index] = { ...reels[index]!, unmapped: [...reels[index]!.unmapped, feature.id] }
  }
  if (orphans.length > 0) {
    reels.push({ file: "other", title: "Features outside the mock", intro: "Features whose journey has no reel in the design mock.", steps: [], unmapped: orphans })
  }

  const byTestFile = (ref: ProofRef) => tests.find(test => sameFile(test.file, ref.file))
  const features: Record<string, FeatureModel> = {}
  for (const feature of input.features) {
    const test = feature.proof.length === 0 ? undefined : byTestFile(feature.proof[0]!)
    const shot = input.shot?.(feature.id, test)
    features[feature.id] = {
      id: feature.id,
      title: feature.title,
      journey: feature.journey,
      status: feature.status,
      ...(feature.gap === undefined || feature.gap === "" ? {} : { gap: feature.gap }),
      verdict: verdicts.get(feature.id)!,
      ...(shot === undefined ? {} : { shot }),
      tests: feature.proof.map(ref => {
        const line = input.stepLine?.(ref)
        return { label: `${basename(ref.file)} · ${ref.step}`, href: permalink(repository, input.sha, line === undefined ? ref.file : `${ref.file}#L${line}`) }
      }),
      docs: feature.docs.map(path => ({ label: path, href: permalink(repository, input.sha, path) })),
      code: feature.code.map(path => ({ label: path, href: permalink(repository, input.sha, path) }))
    }
  }

  const journeys = [...new Set(input.features.map(feature => feature.journey))]
  const byJourney = journeys.map(journey => {
    const members = input.features.filter(feature => feature.journey === journey)
    return { journey, works: members.filter(feature => verdicts.get(feature.id)!.kind === "works").length, total: members.length }
  })
  return {
    sha: input.sha,
    time: input.time,
    reels,
    features,
    counts: { works: byJourney.reduce((sum, each) => sum + each.works, 0), total: input.features.length, byJourney },
    disagreements: disagreements(input.features, verdicts),
    unknownSteps
  }
}

// ── HTML ────────────────────────────────────────────────────────────────────

const escape = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;")

/** JSON inside a <script> element: `<` escaped so no string can close the element. */
const scriptJson = (value: unknown): string => JSON.stringify(value).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029")

export const VERDICT_LABEL: Readonly<Record<VerdictKind, string>> = { works: "Works", broken: "Broken", blocked: "Blocked", "not-built": "Not built" }

const verdictText = (verdict: Verdict): string =>
  verdict.kind === "blocked" ? `Blocked by ${verdict.blockedBy}` : VERDICT_LABEL[verdict.kind]

const links = (label: string, list: FeatureModel["tests"]): string =>
  list.length === 0 ? `<span class="none">No ${escape(label.toLowerCase())}</span>`
    : list.map(link => `<a href="${escape(link.href)}" target="_blank" rel="noreferrer" data-link="${escape(label.toLowerCase())}">${escape(label)}: ${escape(link.label)}</a>`).join("")

/** A feature in full: rendered once, at its home step (or its reel's opening frame). */
const featureBlock = (feature: FeatureModel): string => `
      <article class="feature" data-feature-home="${escape(feature.id)}" data-verdict="${feature.verdict.kind}">
        <header><span class="badge" data-verdict="${feature.verdict.kind}">${escape(verdictText(feature.verdict))}</span>
          <button type="button" class="feature-title" data-show-shot="${escape(feature.id)}">${escape(feature.title)}</button><code>${escape(feature.id)}</code></header>
        ${feature.verdict.kind === "broken" && feature.verdict.detail !== undefined ? `<pre class="error">${escape(feature.verdict.detail)}</pre>` : ""}
        ${feature.verdict.kind === "not-built" && feature.verdict.detail !== undefined ? `<p class="gap">${escape(feature.verdict.detail)}</p>` : ""}
        ${feature.gap !== undefined && feature.verdict.kind !== "not-built" ? `<p class="gap">Registry gap: ${escape(feature.gap)}</p>` : ""}
        <nav class="links">${links("Test", feature.tests)}${links("Docs", feature.docs)}${links("Code", feature.code)}</nav>
      </article>`

/** A feature homed at an earlier step: one line pointing back to it. */
const featureRef = (feature: FeatureModel): string =>
  `<p class="feature-ref" data-feature-ref="${escape(feature.id)}"><span class="badge" data-verdict="${feature.verdict.kind}">${escape(verdictText(feature.verdict))}</span>
        <button type="button" class="feature-title" data-show-shot="${escape(feature.id)}">${escape(feature.title)}</button> <code>${escape(feature.id)}</code> (shown at its first step)</p>`

const firstShot = (model: PageModel, ids: ReadonlyArray<string>): string =>
  ids.find(id => model.features[id]?.shot !== undefined) ?? ""

export const renderHtml = (model: PageModel): string => {
  const shots: Record<string, string> = {}
  for (const feature of Object.values(model.features)) if (feature.shot !== undefined) shots[feature.id] = feature.shot
  const frames = model.reels.map((reel, r) => {
    const intro = `
    <section class="frame" data-reel="${r}" data-step="0" hidden>
      <div class="shot"><img alt="" data-shot="${escape(firstShot(model, reel.unmapped))}"><p class="no-shot">${reel.video === undefined ? "No recording for this reel yet." : "Press Space to play the reel."}</p>
        ${reel.video === undefined ? "" : `<video controls preload="metadata" src="${escape(reel.video)}" data-video="${escape(reel.file)}"></video>`}</div>
      <div class="panel"><p class="intro">${escape(reel.intro)}</p>
        ${reel.unmapped.length === 0 ? "" : `<h3>Features with no mock step</h3>${reel.unmapped.map(id => featureBlock(model.features[id]!)).join("")}`}</div>
    </section>`
    const steps = reel.steps.map(step => `
    <section class="frame" data-reel="${r}" data-step="${step.n}" data-mock-step="${escape(step.ref)}" data-verdict="${step.verdict}" hidden>
      <div class="shot"><img alt="Recorded screen for ${escape(step.ref)}" data-shot="${escape(firstShot(model, step.features))}"><p class="no-shot">No recording for this step.</p></div>
      <div class="panel">
        ${step.features.length === 0 ? `<article class="feature" data-verdict="not-built"><header><span class="badge" data-verdict="not-built">Not built</span> No feature in features.json covers this step.</header></article>` : ""}
        ${step.features.map(id => step.home.includes(id) ? featureBlock(model.features[id]!) : featureRef(model.features[id]!)).join("")}
      </div>
    </section>`).join("")
    return intro + steps
  }).join("")
  const reels = model.reels.map(reel => ({
    file: reel.file, title: reel.title, intro: reel.intro, video: reel.video ?? null,
    steps: reel.steps.map(step => ({ ref: step.ref, caption: step.caption, spec: step.spec ?? "", verdict: step.verdict }))
  }))
  const short = model.sha.slice(0, 10)
  const disagreement = model.disagreements.length === 0 ? "" : `<p class="disagree" role="alert">features.json disagrees with this run: ${
    model.disagreements.map(each => `${escape(each.id)} is ${escape(each.status)} but the run says ${escape(VERDICT_LABEL[each.verdict])}`).join("; ")}.</p>`
  return `<!doctype html>
<html lang="en" data-theme="light">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; media-src 'self' file: blob:; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<title>Smithers MVP proof · ${escape(short)}</title>
<style>${STYLE}</style>
</head>
<body>
<div class="root">
  <div class="player" role="toolbar" aria-label="Proof player">
    <div class="bar">
      <span class="brand">Smithers MVP <i>proof</i></span>
      <label class="reels"><span>Reel</span><select aria-label="Reel" id="reel">${
        model.reels.map((reel, r) => `<option value="${r}">${escape(reel.file.toUpperCase())} · ${escape(reel.title)}</option>`).join("")}</select></label>
      <div class="transport">
        <button type="button" id="prev" aria-label="Previous step" title="Previous step (←)">‹</button>
        <button type="button" id="play" class="play" aria-label="Play" title="Play or pause (Space)">▶</button>
        <button type="button" id="next" aria-label="Next step" title="Next step (→)">›</button>
        <span class="count" id="count">0/0</span>
      </div>
      <div class="ticks" id="ticks" aria-label="Steps"></div>
      <button type="button" id="theme" title="Theme (T)">Dark</button>
    </div>
    <div class="meta">
      <span>Commit <a href="${escape(`${REPOSITORY}/commit/${model.sha}`)}" target="_blank" rel="noreferrer"><code id="sha">${escape(short)}</code></a></span>
      <span>Recorded <time id="time" datetime="${escape(model.time)}">${escape(model.time)}</time></span>
      <span class="total" id="total"><b>${model.counts.works}</b> / ${model.counts.total} features work</span>
      ${model.counts.byJourney.map(each => `<span class="journey-count" data-journey="${escape(each.journey)}">${escape(each.journey)} ${each.works}/${each.total}</span>`).join("")}
    </div>
    ${disagreement}
    <p class="caption"><span class="spec" id="spec"></span><span id="caption"></span><span class="verdict" id="verdict"></span></p>
  </div>
  <main class="stage">${frames}
  </main>
</div>
<script type="application/json" id="reels">${scriptJson(reels)}</script>
<script type="application/json" id="shots">${scriptJson(shots)}</script>
<script>${SCRIPT}</script>
</body>
</html>
`
}

const STYLE = `
:root{color-scheme:light;--bg:#f7f4ee;--surface:#fffefa;--surface-2:#efeae0;--text:#211d18;--muted:#665f54;--border:rgb(33 29 24/8%);--border-strong:rgb(33 29 24/14%);
--brand:#0f766e;--success:#0b5b57;--warning:#8c5a08;--danger:#a4442a;--info:#3c6879;--wash-success:rgb(15 118 110/12%);--wash-warning:rgb(232 163 61/16%);--wash-danger:rgb(164 68 42/12%);--wash-info:rgb(60 104 121/12%);
--font-ui:"Inter",ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;--font-mono:"IBM Plex Mono",ui-monospace,SFMono-Regular,Menlo,monospace}
:root[data-theme="dark"]{color-scheme:dark;--bg:#0d1514;--surface:#131b1a;--surface-2:#1a2422;--text:#ece7db;--muted:#a8a193;--border:rgb(236 231 219/10%);--border-strong:rgb(236 231 219/18%);
--brand:#45c4b2;--success:#7fbfb3;--warning:#f0c169;--danger:#d97757;--info:#82a8b8;--wash-success:rgb(127 191 179/14%);--wash-warning:rgb(240 193 105/14%);--wash-danger:rgb(217 119 87/16%);--wash-info:rgb(130 168 184/14%)}
*{box-sizing:border-box}html,body{margin:0;height:100%;background:var(--bg);color:var(--text);font:14px/1.45 var(--font-ui)}
a{color:var(--brand)}code,pre{font-family:var(--font-mono);font-size:12px}
.root{display:flex;flex-direction:column;height:100%}
.player{position:sticky;top:0;z-index:2;background:var(--surface);border-bottom:1px solid var(--border-strong);padding:8px 16px}
.bar{display:flex;align-items:center;gap:14px;flex-wrap:wrap}.brand{font-weight:600}.brand i{color:var(--muted);font-weight:400}
.reels{display:flex;gap:6px;align-items:center;color:var(--muted)}select,button{font:inherit;color:var(--text);background:var(--surface-2);border:1px solid var(--border-strong);border-radius:8px;padding:3px 10px;cursor:pointer}
.transport{display:flex;gap:4px;align-items:center}.count{color:var(--muted);min-width:4em;text-align:right;font-variant-numeric:tabular-nums}
.ticks{display:flex;gap:2px;flex:1;min-width:120px}.ticks button{flex:1;min-width:4px;height:10px;padding:0;border-radius:3px;border:none;opacity:.45}
.ticks button[data-current]{opacity:1;outline:2px solid var(--text);outline-offset:1px}
[data-verdict="works"].badge,.ticks [data-verdict="works"]{background:var(--wash-success);color:var(--success)}.ticks [data-verdict="works"]{background:var(--success)}
[data-verdict="broken"].badge{background:var(--wash-danger);color:var(--danger)}.ticks [data-verdict="broken"]{background:var(--danger)}
[data-verdict="blocked"].badge{background:var(--wash-warning);color:var(--warning)}.ticks [data-verdict="blocked"]{background:var(--warning)}
[data-verdict="not-built"].badge{background:var(--surface-2);color:var(--muted)}.ticks [data-verdict="not-built"]{background:var(--muted)}
.badge{display:inline-block;border-radius:999px;padding:1px 9px;font-size:12px;font-weight:600;white-space:nowrap}
.meta{display:flex;gap:14px;flex-wrap:wrap;color:var(--muted);margin-top:6px;font-size:12px}.meta b{color:var(--text)}
.journey-count{background:var(--surface-2);border-radius:6px;padding:0 6px}
.disagree{margin:6px 0 0;padding:6px 10px;border-radius:8px;background:var(--wash-danger);color:var(--danger)}
.caption{margin:8px 0 0;font-size:15px;display:flex;gap:10px;align-items:baseline}.spec{color:var(--muted);font-family:var(--font-mono);font-size:12px}.verdict{margin-left:auto}
.stage{flex:1;overflow:auto;padding:16px}
.frame{display:grid;grid-template-columns:minmax(0,3fr) minmax(280px,2fr);gap:16px;align-items:start}
.frame[hidden]{display:none}
.shot{background:var(--surface);border:1px solid var(--border-strong);border-radius:10px;padding:8px;min-height:240px;display:flex;flex-direction:column;gap:8px}
.shot img{max-width:100%;border-radius:6px;display:block}.shot img:not([src]){display:none}.shot img[src]+.no-shot{display:none}.no-shot{color:var(--muted);margin:auto}
.shot video{max-width:100%;border-radius:6px}
.panel{display:flex;flex-direction:column;gap:10px}.panel h3{margin:4px 0 0;font-size:13px;color:var(--muted)}.intro{margin:0;font-size:15px}
.feature{background:var(--surface);border:1px solid var(--border-strong);border-radius:10px;padding:10px 12px}
.feature header{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.feature header code{color:var(--muted)}
.feature-title{background:none;border:none;padding:0;font-weight:600;text-align:left}
.feature-ref{margin:0;display:flex;gap:8px;align-items:center;flex-wrap:wrap;color:var(--muted)}
.error{white-space:pre-wrap;background:var(--wash-danger);color:var(--danger);border-radius:6px;padding:8px;max-height:220px;overflow:auto;margin:8px 0 0}
.gap{margin:8px 0 0;color:var(--muted)}.links{display:flex;flex-direction:column;gap:2px;margin-top:8px;font-size:12px}.none{color:var(--muted)}
@media (max-width:900px){.frame{grid-template-columns:1fr}}
`

/* The player: the mock's keys (Space play/pause, ← → step, 1–9 reel, T theme) over statically rendered frames. */
const SCRIPT = `
(() => {
  const reels = JSON.parse(document.getElementById("reels").textContent)
  const shots = JSON.parse(document.getElementById("shots").textContent)
  const params = new URLSearchParams(location.search)
  const LABEL = { works: "Works", broken: "Broken", blocked: "Blocked", "not-built": "Not built" }
  let reel = Math.max(0, Math.min(Number(params.get("j") ?? 0) || 0, reels.length - 1))
  let index = 0
  let timer
  const $ = id => document.getElementById(id)
  const setTheme = theme => { document.documentElement.dataset.theme = theme; $("theme").textContent = theme === "light" ? "Dark" : "Light" }
  setTheme(params.get("theme") === "dark" || (params.get("theme") === null && matchMedia("(prefers-color-scheme: dark)").matches) ? "dark" : "light")
  const fill = frame => frame.querySelectorAll("img[data-shot]").forEach(img => {
    const id = img.dataset.shot
    if (id && shots[id] && img.getAttribute("src") !== shots[id]) img.src = shots[id]
  })
  const show = () => {
    const current = reels[reel]
    index = Math.max(0, Math.min(index, current.steps.length))
    document.querySelectorAll(".frame").forEach(frame => {
      const on = Number(frame.dataset.reel) === reel && Number(frame.dataset.step) === index
      frame.hidden = !on
      if (on) fill(frame)
      else frame.querySelectorAll("video").forEach(video => video.pause())
    })
    $("reel").value = String(reel)
    $("count").textContent = index + "/" + current.steps.length
    const step = index === 0 ? undefined : current.steps[index - 1]
    $("spec").textContent = step === undefined ? current.file.toUpperCase() : step.ref
    $("caption").textContent = step === undefined ? current.intro : step.caption
    $("verdict").innerHTML = ""
    if (step !== undefined) {
      const badge = document.createElement("span")
      badge.className = "badge"; badge.dataset.verdict = step.verdict; badge.textContent = LABEL[step.verdict]
      $("verdict").append(badge)
    }
    const ticks = $("ticks")
    ticks.replaceChildren(...current.steps.map((each, i) => {
      const tick = document.createElement("button")
      tick.type = "button"; tick.title = (i + 1) + ". " + each.caption; tick.dataset.verdict = each.verdict
      tick.setAttribute("aria-label", "Step " + (i + 1) + ": " + LABEL[each.verdict])
      if (i + 1 === index) tick.dataset.current = ""
      tick.onclick = () => { pause(); index = i + 1; show() }
      return tick
    }))
    const next = new URLSearchParams(location.search); next.set("j", String(reel)); next.set("s", String(index))
    history.replaceState(null, "", "?" + next)
  }
  const pause = () => { clearInterval(timer); timer = undefined; $("play").textContent = "▶"; $("play").setAttribute("aria-label", "Play"); document.querySelectorAll("video").forEach(v => v.pause()) }
  const play = () => {
    if (index >= reels[reel].steps.length) index = 0
    $("play").textContent = "❚❚"; $("play").setAttribute("aria-label", "Pause")
    if (index === 0) { const video = document.querySelector('.frame:not([hidden]) video'); if (video) video.play().catch(() => {}) }
    timer = setInterval(() => {
      if (index >= reels[reel].steps.length) { pause(); return }
      index += 1; show()
    }, 3200)
  }
  const toggle = () => timer === undefined ? play() : pause()
  const pick = r => { pause(); reel = r; index = 0; show() }
  $("play").onclick = toggle
  $("prev").onclick = () => { pause(); index -= 1; show() }
  $("next").onclick = () => { pause(); index += 1; show() }
  $("reel").onchange = event => pick(Number(event.target.value))
  $("theme").onclick = () => setTheme(document.documentElement.dataset.theme === "light" ? "dark" : "light")
  document.addEventListener("click", event => {
    const button = event.target.closest("[data-show-shot]")
    if (!button) return
    const img = button.closest(".frame").querySelector(".shot img")
    const id = button.dataset.showShot
    if (shots[id]) { img.dataset.shot = id; img.src = shots[id] }
  })
  addEventListener("keydown", event => {
    if (event.metaKey || event.ctrlKey || event.altKey) return
    if (event.target instanceof HTMLSelectElement || event.target instanceof HTMLVideoElement) return
    if (event.key === " ") { event.preventDefault(); toggle() }
    else if (event.key === "ArrowRight") { event.preventDefault(); pause(); index += 1; show() }
    else if (event.key === "ArrowLeft") { event.preventDefault(); pause(); index -= 1; show() }
    else if (event.key.toLowerCase() === "t") setTheme(document.documentElement.dataset.theme === "light" ? "dark" : "light")
    else if (/^[1-9]$/.test(event.key) && reels[Number(event.key) - 1] !== undefined) pick(Number(event.key) - 1)
  })
  index = Number(params.get("s") ?? 0) || 0
  show()
})()
`

// ── Files ───────────────────────────────────────────────────────────────────

/** Mock captions: apps/app/proof/mock-steps.json, as proof-registry writes it ({file,title,intro,steps:[string|{caption,spec}]}). */
export const parseMock = (raw: unknown): ReadonlyArray<MockReel> => {
  const list = Array.isArray(raw) ? raw : (raw as { journeys?: unknown }).journeys
  if (!Array.isArray(list)) throw new Error("mock steps: expected an array of journeys")
  return list.map((entry: Record<string, unknown>) => {
    const file = String(entry.file ?? entry.id ?? "")
    if (file === "") throw new Error("mock steps: a journey has no file")
    const steps = (entry.steps as ReadonlyArray<unknown> ?? []).map(step =>
      typeof step === "string" ? { caption: step }
        : { caption: String((step as MockStep).caption), ...((step as MockStep).spec === undefined ? {} : { spec: String((step as MockStep).spec) }) })
    return { file, title: String(entry.title ?? file), intro: String(entry.intro ?? ""), steps }
  })
}

/** The mock's own journeys, when mock-steps.json has not been generated: evaluated from .specs/design/mock/src/journeys. */
const mockFromJourneys = async (root: string): Promise<ReadonlyArray<MockReel>> => {
  const dir = join(root, ".specs/design/mock/src/journeys")
  const { JOURNEYS } = await import(join(dir, "index.ts")) as { JOURNEYS: ReadonlyArray<{ id: string; title: string; intro: string; steps: ReadonlyArray<MockStep> }> }
  const source = readFileSync(join(dir, "index.ts"), "utf8")
  /* The file a journey lives in is the id mockSteps use (j1, run, agent, ask); States and Later are catalogues, not journeys. */
  return JOURNEYS
    .map((journey, i) => ({ journey, file: fileFor(source, journey, i) }))
    .filter(({ file }) => file !== "states" && file !== "later")
    .map(({ journey, file }) => ({ file, title: journey.title, intro: journey.intro, steps: journey.steps.map(step => ({ caption: step.caption, ...(step.spec === undefined ? {} : { spec: step.spec }) })) }))
}

/* JOURNEYS is an array literal of imported names; position i names the import whose file is the journey file. */
const fileFor = (source: string, journey: { id: string }, i: number): string => {
  const literal = /JOURNEYS[^=]*=\s*\[([^\]]*)\]/.exec(source)?.[1] ?? ""
  const name = literal.split(",").map(part => part.trim()).filter(Boolean)[i]
  const file = name === undefined ? undefined : new RegExp(`import \\{ ${name} \\} from "\\./([\\w-]+)"`).exec(source)?.[1]
  return file ?? journey.id
}

/** A proof step's line in its spec file: the first line naming the step id in quotes. */
export const lineOf = (text: string, step: string): number | undefined => {
  const lines = text.split("\n")
  const quoted = [`"${step}"`, `'${step}'`, `\`${step}\``]
  const at = lines.findIndex(line => quoted.some(q => line.includes(q)))
  return at < 0 ? undefined : at + 1
}

const resolveAttachment = (resultsDir: string, attachment: PwAttachment): string | undefined => {
  if (attachment.path === undefined) return undefined
  if (isAbsolute(attachment.path) && existsSync(attachment.path)) return attachment.path
  const relativePath = resolve(resultsDir, attachment.path)
  return existsSync(relativePath) ? relativePath : undefined
}

const shotFrom = (resultsDir: string) => (featureId: string, test: RecordedTest | undefined): string | undefined => {
  if (test === undefined) return undefined
  const attachment = (test.result.attachments ?? []).find(each => each.contentType.startsWith("image/") && (each.name === featureId || titleNames(each.name, featureId)))
  if (attachment === undefined) return undefined
  if (attachment.body !== undefined) return `data:${attachment.contentType};base64,${attachment.body}`
  const path = resolveAttachment(resultsDir, attachment)
  return path === undefined ? undefined : `data:${attachment.contentType};base64,${readFileSync(path).toString("base64")}`
}

/** The journey test of a reel is the test in a spec file named after it (e2e/proof/j1.spec.ts for j1); its video is copied beside the page. */
const videoFrom = (resultsDir: string, out: string) => (reel: MockReel, tests: ReadonlyArray<RecordedTest>): string | undefined => {
  const test = tests.find(each => basename(each.file).replace(/\.(spec|test|pw)\.[cm]?[jt]sx?$/, "") === reel.file)
  const attachment = test?.result.attachments?.find(each => each.contentType.startsWith("video/"))
  const path = attachment === undefined ? undefined : resolveAttachment(resultsDir, attachment)
  if (path === undefined) return undefined
  const name = `videos/${reel.file}${extname(path) || ".webm"}`
  mkdirSync(join(out, "videos"), { recursive: true })
  copyFileSync(path, join(out, name))
  return name
}

const shaOf = (report: PwReport, root: string): string => {
  const metadata = report.config?.metadata ?? {}
  for (const key of ["smithers.sha", "sha", "commit", "gitCommit", "revision.id", "git.commit.hash"]) {
    const value = metadata[key]
    if (typeof value === "string" && /^[0-9a-f]{7,40}$/.test(value)) return value
    if (value !== null && typeof value === "object" && typeof (value as { hash?: unknown }).hash === "string") return (value as { hash: string }).hash
  }
  if (process.env.SMITHERS_BUILD_SHA !== undefined && /^[0-9a-f]{7,40}$/.test(process.env.SMITHERS_BUILD_SHA)) return process.env.SMITHERS_BUILD_SHA
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim()
}

export interface GenerateOptions {
  readonly root: string
  readonly features: string
  readonly results: string
  readonly mock?: string
  readonly out: string
}

export const generate = async (options: GenerateOptions): Promise<PageModel> => {
  const features = JSON.parse(readFileSync(options.features, "utf8")) as ReadonlyArray<Feature>
  const report = JSON.parse(readFileSync(options.results, "utf8")) as PwReport
  const mock = options.mock !== undefined && existsSync(options.mock)
    ? parseMock(JSON.parse(readFileSync(options.mock, "utf8")))
    : await mockFromJourneys(options.root)
  const resultsDir = dirname(options.results)
  mkdirSync(options.out, { recursive: true })
  const model = buildModel({
    features, mock, report,
    sha: shaOf(report, options.root),
    time: report.stats?.startTime ?? new Date().toISOString(),
    stepLine: ref => {
      const path = join(options.root, ref.file)
      return existsSync(path) ? lineOf(readFileSync(path, "utf8"), ref.step) : undefined
    },
    shot: shotFrom(resultsDir),
    video: videoFrom(resultsDir, options.out)
  })
  writeFileSync(join(options.out, "index.html"), renderHtml(model))
  return model
}
