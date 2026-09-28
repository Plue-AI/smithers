/*
 * Refresh the TypeScript copy of Smithers' failure-code registry.
 *
 *   node scripts/refresh-failure-codes.mjs
 *   node scripts/refresh-failure-codes.mjs --check
 *
 * Smithers Go owns the taxonomy in packages/backend/internal/pkg/errors.
 * Its checked-in document is docs/api/failure-codes.json, and
 * GET /api/meta/failure-codes serves the same bytes. This script copies the
 * document into src/plue-failure-codes.json UNCHANGED and regenerates
 * src/PlueFailureCodes.ts from them, which is where the codes become types.
 *
 * Run it in the same change that edits the Go registry. Without the
 * regeneration a new code has no row, and `satisfies Record<PlueFailureCode,
 * PlueFailureEntry>` in the generated file makes that a compile error rather
 * than a refusal the app renders as a shrug. `--check` fails instead of
 * writing, which is what the drift test and CI want.
 */
import { readFileSync, writeFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const canonicalPath = join(here, "..", "..", "..", "docs", "api", "failure-codes.json")
const jsonPath = join(here, "..", "src", "plue-failure-codes.json")
const tsPath = join(here, "..", "src", "PlueFailureCodes.ts")

/**
 * The digest Go computes: sha256 over `json.Marshal(records)` — Go's compact
 * encoding of the code rows in the document's own order, with Go's default
 * HTML escaping. Reproducing it here rather than trusting the field is the
 * whole point of the drift test: a hand-edited row changes the payload and
 * stops matching.
 */
export const digestOf = (codes) => {
  const escape = (text) =>
    text.replace(new RegExp("[<>&\\u2028\\u2029]", "g"), (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"))
  const rows = codes.map((row) =>
    escape(
      JSON.stringify({ code: row.code, fault: row.fault, status: row.status, retry_after: row.retry_after, doc: row.doc })
    )
  )
  return "sha256:" + createHash("sha256").update(`[${rows.join(",")}]`).digest("hex")
}

const quote = (text) => JSON.stringify(text)

const CODE = /^[A-Za-z][A-Za-z0-9_]*$/u
const FAULT = /^[a-z][a-z_]*$/u
const DIGEST = /^sha256:[0-9a-f]{64}$/u
const isCount = (value) => Number.isSafeInteger(value) && value >= 0

/**
 * The document is data, and the generated file is code: every field that
 * reaches the TypeScript is checked for its shape first, so a row can never
 * close a literal and open a statement. The digest proves nothing here — the
 * same document supplies it — so validation, not the digest, is the gate.
 */
export const validationErrors = (document) => {
  if (document === null || typeof document !== "object") return ["the document is not an object"]
  const errors = []
  if (!isCount(document.schema_version)) errors.push("schema_version is not a non-negative integer")
  if (typeof document.digest !== "string" || !DIGEST.test(document.digest)) errors.push("digest is not sha256:<64 hex>")
  const faults = Array.isArray(document.faults) ? document.faults : []
  if (faults.length === 0 || !faults.every((fault) => typeof fault === "string" && FAULT.test(fault))) {
    errors.push("faults is not a non-empty list of lowercase words")
  }
  if (!Array.isArray(document.codes)) return [...errors, "codes is not a list"]
  for (const [index, row] of document.codes.entries()) {
    const at = `codes[${index}]`
    if (row === null || typeof row !== "object") {
      errors.push(`${at} is not an object`)
      continue
    }
    if (typeof row.code !== "string" || !CODE.test(row.code)) errors.push(`${at}.code is not an identifier`)
    if (!faults.includes(row.fault)) errors.push(`${at}.fault is not one of faults`)
    if (!Number.isSafeInteger(row.status) || row.status < 100 || row.status > 599) {
      errors.push(`${at}.status is not an HTTP status`)
    }
    if (!isCount(row.retry_after)) errors.push(`${at}.retry_after is not a non-negative integer`)
    if (typeof row.doc !== "string") errors.push(`${at}.doc is not a string`)
  }
  return errors
}

const render = (document) => {
  const faults = document.faults.map(quote).join(", ")
  const codes = document.codes.map((row) => `  ${quote(row.code)}`).join(",\n")
  const entries = document.codes
    .map((row) =>
      `  /** ${row.doc.replace(/\*\//gu, "*\\/")} */\n  ${quote(row.code)}: { fault: ${quote(row.fault)}, status: ${row.status}, retryAfter: ${row.retry_after} }`
    )
    .join(",\n")
  return `/**
 * Smithers' failure taxonomy, generated as types.
 *
 * GENERATED FILE — do not edit. Regenerate with:
 *
 *   node packages/rpc/scripts/refresh-failure-codes.mjs
 *
 * Source: docs/api/failure-codes.json, rendered by Smithers Go and
 * served at GET /api/meta/failure-codes. WHICH revision is the digest below,
 * not a path — a local checkout's location is not provenance, and putting one
 * here would rewrite this file on every machine that regenerated it.
 *
 * Smithers' closed failure taxonomy, generated so the
 * codes are TYPES here and not strings. Everything downstream — the fault a
 * refusal carries, the copy the app puts in front of it, whether the app may
 * retry on its own — is derived from this table, so a code plue adds and this
 * file has not picked up is a compile error at the table below, never a
 * refusal the user is shown with no verdict on it.
 *
 * @since 1.0.0
 */

/**
 * The document schema version Go stamps; a bump means the shape changed, not just the rows.
 *
 * @since 1.0.0
 * @category constants
 */
export const PLUE_FAILURE_SCHEMA_VERSION = ${document.schema_version}

/**
 * Go's digest over the code rows. The drift test recomputes it from the
 * vendored JSON, so this constant and that file cannot disagree silently.
 *
 * @since 1.0.0
 * @category constants
 */
export const PLUE_FAILURE_DIGEST = ${quote(document.digest)}

/**
 * Whose problem a failure is — the registry's verdict, and the only question the app
 * actually needs answered to know what to say.
 *
 * - \`user\` the request has to change; retrying it unchanged fails the same way.
 * - \`wait\` nothing is wrong, it is not ready yet, and the server said how long.
 * - \`infra\` Smithers' own fleet failed the caller. Not their fault.
 * - \`dependency\` something Smithers depends on failed or throttled us.
 * - \`bug\` Smithers is defective here.
 *
 * @since 1.0.0
 * @category constants
 */
export const PLUE_FAULTS = [${faults}] as const

/**
 * Whose problem a failure is.
 *
 * @since 1.0.0
 * @category models
 */
export type PlueFault = (typeof PLUE_FAULTS)[number]

/**
 * Every code Smithers may put on the wire, in the artifact's own sorted order.
 *
 * @since 1.0.0
 * @category constants
 */
export const PLUE_FAILURE_CODES = [
${codes}
] as const

/**
 * One of Smithers' failure codes.
 *
 * @since 1.0.0
 * @category models
 */
export type PlueFailureCode = (typeof PLUE_FAILURE_CODES)[number]

/**
 * One row: the verdict, the status Smithers answers with, and the pacing it states (0 = none).
 *
 * @since 1.0.0
 * @category models
 */
export interface PlueFailureEntry {
  readonly fault: PlueFault
  readonly status: number
  readonly retryAfter: number
}

/**
 * The registry itself. \`satisfies Record<PlueFailureCode, PlueFailureEntry>\`
 * is the exhaustiveness gate: a code in the union with no row here, or a row
 * here for a code not in the union, does not compile.
 *
 * @since 1.0.0
 * @category constants
 */
export const PLUE_FAILURES = {
${entries}
} satisfies Record<PlueFailureCode, PlueFailureEntry>
`
}

const load = async (from) => {
  if (/^[a-z][a-z0-9+.-]*:/iu.test(from) && !from.startsWith("https://")) {
    throw new Error(`--from ${from}: only https:// URLs or local files are read`)
  }
  if (from.startsWith("https://")) {
    const url = `${from.replace(/\/+$/u, "")}/api/meta/failure-codes`
    const response = await fetch(url)
    if (!response.ok) throw new Error(`${url} answered ${response.status}`)
    return { text: await response.text(), source: url }
  }
  const path = resolve(from.replace(/^~(?=\/|$)/u, process.env.HOME ?? "~"))
  const file = path.endsWith(".json") ? path : join(path, "docs", "failure-codes.json")
  /*
   * The generated header records WHICH artifact, never whose disk: a local
   * checkout path would rewrite the file for every machine that regenerates
   * it and turn a no-op refresh into a diff.
   */
  return { text: readFileSync(file, "utf8"), source: "plue docs/failure-codes.json" }
}

const main = async () => {
  const args = process.argv.slice(2)
  const check = args.includes("--check")
  const fromIndex = args.indexOf("--from")
  const from = fromIndex < 0 ? null : args[fromIndex + 1]
  const { text, source } = from === null
    ? { text: readFileSync(canonicalPath, "utf8"), source: canonicalPath }
    : await load(from)
  const document = JSON.parse(text)
  const invalid = validationErrors(document)
  if (invalid.length > 0) {
    console.error(`refresh-failure-codes: ${source} is not a failure-code document:\n  ${invalid.join("\n  ")}`)
    process.exit(1)
  }
  const recomputed = digestOf(document.codes)
  if (recomputed !== document.digest) {
    console.error(`refresh-failure-codes: ${source} carries ${document.digest} but its rows hash to ${recomputed}`)
    process.exit(1)
  }
  const rendered = render(document)
  if (check) {
    const stale = [
      ...(readFileSync(jsonPath, "utf8") === text ? [] : [jsonPath]),
      readFileSync(tsPath, "utf8") === rendered ? null : tsPath
    ].filter((path) => path !== null)
    if (stale.length > 0) {
      console.error(`refresh-failure-codes: stale against ${source}:\n  ${stale.join("\n  ")}`)
      process.exit(1)
    }
    console.log(`refresh-failure-codes: fresh against ${source} (${document.codes.length} codes, ${document.digest})`)
    return
  }
  if (from !== null) writeFileSync(canonicalPath, text)
  writeFileSync(jsonPath, text)
  writeFileSync(tsPath, rendered)
  console.log(`refresh-failure-codes: wrote ${document.codes.length} codes from ${source} (${document.digest})`)
}

if (process.argv[1] !== undefined && import.meta.url === `file://${resolve(process.argv[1])}`) await main()
