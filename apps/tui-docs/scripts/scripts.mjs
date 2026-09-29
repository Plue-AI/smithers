/** A strict, reviewable recording language. Setup names select repository-owned fixtures. */
import { readFileSync } from "node:fs"
import { walk } from "./inputs.mjs"
export const keys = {
  Enter: "\r",
  Escape: "\x1b",
  Tab: "\t",
  Backspace: "\x7f",
  Space: " ",
  Home: "\x1b[H",
  End: "\x1b[F",
  PageUp: "\x1b[5~",
  PageDown: "\x1b[6~",
  ArrowUp: "\x1b[A",
  ArrowDown: "\x1b[B",
  ArrowLeft: "\x1b[D",
  ArrowRight: "\x1b[C",
  "Shift+Tab": "\x1b[Z",
  "Shift+ArrowLeft": "\x1b[1;2D",
  "Shift+ArrowRight": "\x1b[1;2C",
  "Alt+Enter": "\x1b\r",
  "Alt+ArrowUp": "\x1b[1;3A",
  "Ctrl+]": "\x1d",
  "Ctrl+\\": "\x1c",
  ...Object.fromEntries(
    "ACDGJKLOPSTUW".split("").map((letter) => [`Ctrl+${letter}`, String.fromCharCode(letter.charCodeAt(0) - 64)])
  ),
  "Alt+R": "\x1br"
}
export function parseScripts(markdown) {
  const scripts = []
  for (const match of markdown.matchAll(/^```(tui-script|browser-script)\s+([^\n]+)\n([\s\S]*?)^```\s*$/gm)) {
    const id = match[2].trim(), kind = match[1] === "browser-script" ? "browser" : "terminal"
    if (!/^[a-z][a-z0-9-]*$/.test(id)) throw new Error(`Invalid recording id: ${id}`)
    const steps = match[3].split("\n").filter((line) => line.trim()).map((line) => {
      const text = /^(Use|Type|Wait for answer|Wait for|Capture|Click) ("(?:[^"\\]|\\.)*")$/.exec(line)
      if (text) return { kind: text[1], value: JSON.parse(text[2]) }
      const press = /^Press (.+)$/.exec(line)
      if (press && (Object.hasOwn(keys, press[1]) || /^[a-z?\[\]]$/.test(press[1]))) {
        return { kind: "Press", value: press[1] }
      }
      const status = /^Wait for (worker|monitor) ("(?:[^"\\]|\\.)*") status ("(?:[^"\\]|\\.)*")$/.exec(line)
      if (status) {
        return { kind: "Wait for status", subject: status[1], id: JSON.parse(status[2]), value: JSON.parse(status[3]) }
      }
      const wait = /^Wait (\d+) ms$/.exec(line)
      if (wait && Number(wait[1]) <= 10_000) return { kind: "Wait", value: Number(wait[1]) }
      const file = /^Expect file ("(?:[^"\\]|\\.)*") contains ("(?:[^"\\]|\\.)*")$/.exec(line)
      if (file) return { kind: "Expect file", path: JSON.parse(file[1]), value: JSON.parse(file[2]) }
      const fill = /^Fill ("(?:[^"\\]|\\.)*") with ("(?:[^"\\]|\\.)*")$/.exec(line)
      if (fill) return { kind: "Fill", target: JSON.parse(fill[1]), value: JSON.parse(fill[2]) }
      if (line === "Restart") return { kind: "Restart" }
      throw new Error(`Invalid recording instruction: ${line}`)
    })
    if (!steps.some((step) => step.kind === "Capture")) throw new Error(`Recording ${id} needs Capture`)
    if (
      steps.filter((step) => step.kind === "Use").length > 1 || steps.some((step, i) => step.kind === "Use" && i !== 0)
    ) throw new Error(`Recording ${id}: Use must be first`)
    const allowed = kind === "browser"
      ? ["Click", "Fill", "Wait for", "Capture"]
      : [
        "Use",
        "Type",
        "Press",
        "Wait for",
        "Wait for answer",
        "Wait for status",
        "Wait",
        "Capture",
        "Expect file",
        "Restart"
      ]
    for (const step of steps) {
      if (!allowed.includes(step.kind)) {
        throw new Error(`Recording ${id}: ${step.kind} is unsupported in ${kind} scripts`)
      }
      if (step.kind === "Expect file" && !/^[a-zA-Z0-9_-][a-zA-Z0-9_.-]*$/.test(step.path)) {
        throw new Error(`Invalid fixture path: ${step.path}`)
      }
      if (
        step.kind === "Wait for status" && !(step.subject === "worker"
          ? ["requested", "queued", "running", "waiting", "parked", "done", "failed", "cancelled"]
          : ["active", "stopped", "failed"]).includes(step.value)
      ) throw new Error(`Invalid ${step.subject} status: ${step.value}`)
    }
    scripts.push({ id, kind, steps })
  }
  return scripts
}
/** Every recording the Markdown under `docsDir` declares, keyed by id; one id has one script. */
export function collectScripts(docsDir) {
  const scripts = new Map()
  for (const file of walk(docsDir).filter((f) => f.endsWith(".md"))) {
    for (const script of parseScripts(readFileSync(file, "utf8"))) {
      const previous = scripts.get(script.id)
      if (previous && JSON.stringify(previous) !== JSON.stringify(script)) {
        throw new Error(`Conflicting recording ${script.id}`)
      }
      scripts.set(script.id, script)
    }
  }
  return scripts
}
