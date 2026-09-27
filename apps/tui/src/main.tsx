#!/usr/bin/env bun
/**
 * The TUI entry. Static imports link before any code runs, so an old Bun fails
 * with an unexplained `No such built-in module: node:sqlite`; this checks the
 * runtime first and loads the TUI only once it can run.
 */
import * as Runtime from "./runtime-version.ts"

const problem = Runtime.problem(process.versions)
if (problem !== undefined) {
  process.stderr.write(`${problem}\n`)
  process.exit(1)
}
await import("./run.tsx")
