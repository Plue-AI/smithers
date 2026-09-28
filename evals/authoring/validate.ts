/**
 * Validates the SFT dataset before it is uploaded or trained on.
 *
 * The exit code is the verdict, so this runs as a `NodeTest` gate: it proves
 * every row is a well-formed OpenAI chat example before an irreversible
 * `firectl dataset create` ships it to Fireworks. `firectl` uploads each row
 * verbatim, so the gate also rejects anything that must not leave this machine:
 * top-level metadata beside `messages`, absolute host paths, and credential
 * shapes. It reads its dataset relative to its own location, so the check is
 * independent of the working directory the runner spawns it from. It depends
 * on nothing outside the runtime.
 */
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const roles = new Set(["system", "user", "assistant", "tool"])
const messageKeys = new Set(["role", "content"])

/**
 * Content that must never reach the training corpus: a home directory reveals
 * the maintainer's username and layout, and a credential shape is a leaked key.
 */
const forbidden: ReadonlyArray<{ readonly label: string; readonly pattern: RegExp }> = [
  {
    label: "absolute host path",
    pattern: /(?:\/(?:Users|home)\/[A-Za-z0-9._-]+|\b[A-Za-z]:\\Users\\[A-Za-z0-9._-]+|(?:^|[\s"'`(=:])~[A-Za-z0-9._-]*\/)/
  },
  { label: "Fireworks API key", pattern: /\bfw_[A-Za-z0-9]{16,}/ },
  { label: "OpenAI-style API key", pattern: /\bsk-[A-Za-z0-9_-]{16,}/ },
  { label: "GitHub token", pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/ },
  { label: "AWS access key", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { label: "Slack token", pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { label: "private key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { label: "JSON Web Token", pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/ }
]

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const validateRow = (parsed: unknown, row: number): ReadonlyArray<string> => {
  if (!isRecord(parsed)) {
    return [`row ${row}: not a JSON object`]
  }
  const problems: string[] = []
  const extraKeys = Object.keys(parsed).filter((key) => key !== "messages")
  if (extraKeys.length > 0) {
    problems.push(`row ${row}: unexpected top-level key(s) ${extraKeys.map((key) => JSON.stringify(key)).join(", ")}`)
  }

  const messages = parsed.messages
  if (!Array.isArray(messages) || messages.length === 0) {
    problems.push(`row ${row}: missing a non-empty "messages" array`)
    return problems
  }

  messages.forEach((message: unknown, messageIndex) => {
    const at = `row ${row}, message ${messageIndex + 1}`
    if (!isRecord(message)) {
      problems.push(`${at}: not a JSON object`)
      return
    }
    const extraMessageKeys = Object.keys(message).filter((key) => !messageKeys.has(key))
    if (extraMessageKeys.length > 0) {
      problems.push(`${at}: unexpected key(s) ${extraMessageKeys.map((key) => JSON.stringify(key)).join(", ")}`)
    }
    if (typeof message.role !== "string" || !roles.has(message.role)) {
      problems.push(`${at}: role ${JSON.stringify(message.role)} is not one of ${[...roles].join(", ")}`)
    }
    if (typeof message.content !== "string" || message.content.trim().length === 0) {
      problems.push(`${at}: content is empty or not a string`)
      return
    }
    for (const { label, pattern } of forbidden) {
      if (pattern.test(message.content)) problems.push(`${at}: content contains ${label}`)
    }
  })

  const lastIndex = messages.length - 1
  const last: unknown = messages[lastIndex]
  if (!isRecord(last) || last.role !== "assistant") {
    problems.push(`row ${row}: last message is not an "assistant" turn`)
  }
  const userBeforeLast = messages.slice(0, lastIndex).some((message: unknown) => isRecord(message) && message.role === "user")
  if (!userBeforeLast) {
    problems.push(`row ${row}: no "user" turn before the final assistant turn`)
  }
  return problems
}

/**
 * Returns every problem in a JSONL dataset; an empty list means it may ship.
 */
export const validateDataset = (text: string): ReadonlyArray<string> => {
  const lines = text.split("\n").filter((line) => line.trim().length > 0)
  if (lines.length === 0) {
    return ["dataset is empty"]
  }
  return lines.flatMap((line, index) => {
    const row = index + 1
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch (error) {
      return [`row ${row}: not valid JSON: ${(error as Error).message}`]
    }
    return validateRow(parsed, row)
  })
}

if (import.meta.main) {
  const datasetPath = fileURLToPath(new URL("./data/pilot-sft.jsonl", import.meta.url))
  const text = readFileSync(datasetPath, "utf8")
  const problems = validateDataset(text)
  if (problems.length > 0) {
    console.error(`FAIL: ${problems.length} problem(s) in ${datasetPath}`)
    for (const problem of problems) console.error(`  - ${problem}`)
    process.exit(1)
  }
  const rows = text.split("\n").filter((line) => line.trim().length > 0).length
  console.log(`OK: ${rows} row(s) valid in ${datasetPath}`)
}
