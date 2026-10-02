/*
 * J1 fixtures: the Mac installer's pages, the setup inputs, the source files
 * the first answer and the first TODO touch, and the TODO's texts. A fresh
 * install of acme/api.
 */
import type { CodeLine, Evidence, FileDoc } from "../world"

/** Smithers listens only to the Mac it runs on until the owner lets the network in (mvp.md §6.1). */
export const LOOPBACK = "http://localhost:4000"
/** `smthrs host start` prints this once; opening it claims the install as its owner's (mvp.md J1). */
export const SETUP_LINK = `${LOOPBACK}/setup?claim=7QX2-M9FK`
export const TERMINAL_TITLE = "Terminal — maya@mini"
export const SHELL_PROMPT = "maya@mini ~ % "
export const HOST_START = "smthrs host start"
export const HOST_STARTED: ReadonlyArray<string> = [
  `${SHELL_PROMPT}${HOST_START}`,
  "Smithers is running on this Mac.",
  "",
  "Finish setup with this one-time link:",
  SETUP_LINK
]

/* ── The Mac installer (outside the app) ─────────────────── */

/* The window title; setup.css draws the window as macOS Installer by it. */
export const INSTALLER_TITLE = "Install Smithers"

/* Each page is a heading line, then what the installer puts on the Mac. */
export const INSTALLER_READY: ReadonlyArray<string> = [
  "Ready to install",
  "○  PostgreSQL 18",
  "○  Machine runtime",
  "○  Smithers"
]

export const INSTALLER_DONE: ReadonlyArray<string> = [
  "Installed",
  "✓  PostgreSQL 18",
  "✓  Machine runtime",
  "✓  Smithers"
]

/* ── Setup ───────────────────────────────────────────────── */

/** The coding model's provider. */
export const PROVIDER = "Anthropic"
/* Pasted keys, one per model role. The card masks every character as it is typed. */
export const FAST_KEY = "csk-4tW9mQ2xR7vK1pL8nZ3cH6yB5dF0jG2s"
export const OLD_CODING_KEY = "sk-ant-api03-Wd8kP2nV7xQ4rL6tY1mB5c9e"
export const CODING_KEY = "sk-ant-api03-hN4wQ8rT2mZ6vK1pL9xC3f2a"
export const GATEWAY_KEY = "vck_7Rm2Qx9Lp4Tz8Wn5Kd1Hs91bd"
/** Anthropic's own reason for refusing the first coding key: a 401 authentication_error. */
export const KEY_ERROR = "Anthropic rejected this key: invalid x-api-key"
/** The install's Obsidian folder on the Mac, which Settings edits like the address. */
export const OBSIDIAN = "~/Obsidian/acme-api"

/* ── Source ──────────────────────────────────────────────── */

const code = (text: string): Array<CodeLine> => text.split("\n").map((line, index) => ({ n: index + 1, text: line }))

export const MAIL_PATH = "src/mail/reset.ts"
/** The lines the answer cites: the sender and the event that calls it. */
export const MAIL_CITED = "lines:7-16"

export const mailFile = (): FileDoc => ({
  path: MAIL_PATH, branch: "main", lines: code(`import { APP_URL } from "../config"
import { events } from "../events"
import { createResetToken } from "../auth/reset-token"
import type { User } from "../users"
import { mailer } from "./mailer"

export async function sendPasswordReset(user: User): Promise<void> {
  const token = await createResetToken(user.id)
  await mailer.send({
    to: user.email,
    template: "password-reset-v2",
    data: { name: user.firstName, link: \`\${APP_URL}/reset?token=\${token}\` }
  })
}

events.on("password.reset", ({ user }) => sendPasswordReset(user))`)
})

export const TOKEN_PATH = "src/auth/reset-token.ts"
export const TEST_PATH = "src/auth/reset-token.test.ts"

export const tokenFile = (branch: string): FileDoc => ({
  path: TOKEN_PATH, branch, lines: code(`import { randomBytes } from "node:crypto"
import { db } from "../db"
import { ResetLinkExpired } from "./errors"

const RESET_LINK_TTL_MS = 24 * 60 * 60 * 1000

export async function createResetToken(userId: string): Promise<string> {
  const token = randomBytes(32).toString("hex")
  await db.resetTokens.insert({ userId, token, expiresAt: Date.now() + RESET_LINK_TTL_MS })
  return token
}

export async function redeemResetToken(token: string): Promise<string> {
  const row = await db.resetTokens.take(token)
  if (row === undefined || row.expiresAt <= Date.now()) throw new ResetLinkExpired()
  return row.userId
}`)
})

export const testFile = (branch: string): FileDoc => ({
  path: TEST_PATH, branch, lines: code(`import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { createResetToken, redeemResetToken } from "./reset-token"
import { ResetLinkExpired } from "./errors"

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

it("redeems a fresh reset link", async () => {
  const token = await createResetToken("u_1")
  await expect(redeemResetToken(token)).resolves.toBe("u_1")
})

it("expires a reset link after 24 hours", async () => {
  const token = await createResetToken("u_1")
  vi.advanceTimersByTime(24 * 60 * 60 * 1000)
  await expect(redeemResetToken(token)).rejects.toThrow(ResetLinkExpired)
})`)
})

/** The coding agent's change: three lines in two files. */
export const CHANGE: ReadonlyArray<{ readonly path: string; readonly n: number; readonly text: string }> = [
  { path: TOKEN_PATH, n: 5, text: "const RESET_LINK_TTL_MS = 30 * 60 * 1000" },
  { path: TEST_PATH, n: 13, text: `it("expires a reset link after 30 minutes", async () => {` },
  { path: TEST_PATH, n: 15, text: "  vi.advanceTimersByTime(30 * 60 * 1000)" }
]

/* ── The question and the first TODO ─────────────────────── */

export const QUESTION = "Where do we send password reset emails?"
export const ANSWER = "sendPasswordReset sends them, on every password.reset event."

export const REQUEST = "Make the password reset link expire after 30 minutes"
export const TITLE = "Expire reset links after 30 minutes"
export const PROMPT = "Password reset links should expire 30 minutes after they are sent, not 24 hours. Update the expiry test to match."
export const BRANCH_NAME = "expire-reset-links"
export const PR = 187

export const evidence = (githubPassed: number): Evidence => ({
  files: 2, added: 3, removed: 3,
  checks: [{ name: "typecheck", state: "passed", took: "12s" }, { name: "test", state: "passed", took: "41s" }, { name: "lint", state: "passed", took: "7s" }],
  github: { passed: githubPassed, total: 5 },
  review: "Links expire after 30 minutes instead of 24 hours, and the expiry test checks the new limit."
})
