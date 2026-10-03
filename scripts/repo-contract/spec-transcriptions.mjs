// Hand-transcribed fixtures name the spec text they were copied from. The text
// starts at the line beginning with `start` and ends before the next heading of
// level three or higher; its SHA-256 (UTF-8, LF) is recorded in the fixture.
import { createHash } from "node:crypto"

export function sectionText(markdown, start) {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n")
  const first = lines.findIndex((line) => line.startsWith(start))
  if (first < 0) return null
  const rest = lines.slice(first + 1).findIndex((line) => /^#{1,3} /.test(line))
  return lines.slice(first, rest < 0 ? undefined : first + 1 + rest).join("\n")
}

export const digest = (text) => createHash("sha256").update(text, "utf8").digest("hex")

// Returns null when the fixture still matches its source, else the refusal.
export function staleness(fixturePath, spec, markdown) {
  const text = sectionText(markdown, spec.start)
  if (text === null) return `re-transcribe ${fixturePath} from ${spec.file} "${spec.start}": section missing`
  if (digest(text) !== spec.sha256) return `re-transcribe ${fixturePath} from ${spec.file} "${spec.start}": digest changed`
  return null
}
