/**
 * The machine's durable spend ledger: one append-only JSONL file per UTC day.
 *
 * The journal `Budget` normally recovers from is per run, and this host runs on
 * the memory engine with none, so the per-day cap and a run's recovered spend
 * both read this file. Several `smithers-tui` processes on one machine append
 * to the same day file; one short `O_APPEND` line is atomic. An unreadable line
 * fails the read (the budget then refuses, loudly) instead of counting as zero,
 * except a torn final line from a crash, which is skipped.
 */
import type * as Budget from "@smthrs/agent/Budget"
import * as Effect from "effect/Effect"
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export const directory = (): string =>
  join(process.env.SMITHERS_TUI_SESSION_DIR ?? join(homedir(), ".smithers", "tui"), "spend")

const fileFor = (root: string, day: string): string => join(root, `${day}.jsonl`)

const isEntry = (value: unknown): value is Budget.LedgerEntry =>
  typeof value === "object" && value !== null &&
  typeof (value as Budget.LedgerEntry).day === "string" &&
  typeof (value as Budget.LedgerEntry).runId === "string" &&
  typeof (value as Budget.LedgerEntry).stepKey === "string" &&
  Number.isFinite((value as Budget.LedgerEntry).spent)

/** One day's entries; the first record of a `(runId, stepKey)` wins. */
const read = (root: string, day: string): ReadonlyArray<Budget.LedgerEntry> => {
  const file = fileFor(root, day)
  if (!existsSync(file)) return []
  const text = readFileSync(file, "utf8")
  const lines = text.split("\n")
  const torn = !text.endsWith("\n")
  const seen = new Set<string>()
  const entries: Array<Budget.LedgerEntry> = []
  lines.forEach((line, index) => {
    if (line === "" || (torn && index === lines.length - 1)) return
    const parsed: unknown = JSON.parse(line)
    if (!isEntry(parsed)) throw new Error(`${file} line ${index + 1} is not a spend record`)
    const key = JSON.stringify([parsed.runId, parsed.stepKey])
    if (seen.has(key)) return
    seen.add(key)
    entries.push(parsed)
  })
  return entries
}

const previousDay = (day: string): string => new Date(Date.parse(day) - 86_400_000).toISOString().slice(0, 10)

export const ledger = (root: string = directory()): Budget.Ledger => ({
  total: (day) => Effect.try(() => read(root, day).reduce((sum, entry) => sum + entry.spent, 0)),
  record: (entry) =>
    Effect.try(() => {
      // A retried record may append twice; `read` keeps the first.
      mkdirSync(root, { recursive: true, mode: 0o700 })
      const file = fileFor(root, entry.day)
      appendFileSync(file, JSON.stringify(entry) + "\n", { mode: 0o600 })
      chmodSync(file, 0o600)
    }),
  // A run's steps sit in the day it started or the next; older days are never rescanned.
  run: (runId) =>
    Effect.try(() => {
      const today = new Date().toISOString().slice(0, 10)
      const held = new Map<string, number>()
      for (const day of [previousDay(today), today]) {
        for (const entry of read(root, day)) if (entry.runId === runId) held.set(entry.stepKey, entry.spent)
      }
      return held
    })
})
