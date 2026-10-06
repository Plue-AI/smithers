import type { APIRequestContext, Page } from "@playwright/test"
import { closeComposer, command, expect, realApi, reloadApp } from "../support/test"
import { cloudRepoPath } from "../repositories-github/production"

/** Repository-owned prompt subjects, discovered when the disposable host restarts. */
export const SEEDED_FLOW = "timeline-probe"
export const FAILED_FLOW = "timeline-probe-failed"
/** A subject whose one-token `park` budget refuses its first model call, parking the run on a Runaway guard. */
export const GUARD_FLOW = "guard-probe"
export const MARKER_TEST = "timeline-marker.test.ts"
export const PIN_FILES = ["timeline-pin-1.txt", "timeline-pin-2.txt", "timeline-pin-3.txt"] as const

const flowText = (failure: boolean, marker: string): string => [
  "---",
  "description: Exercise a real agent timeline in a disposable repository.",
  'capabilities: ["fs:read:**", "fs:write:**", "proc:spawn:*"]',
  "model: coding/implement",
  "budget:",
  // Measured 2026-09-20 on host c9935981: the success subject spent 188,669 tokens over twelve turns (two
  // rejected cells retried) and died on a 200,000 budget one call short of finishing; the old host finished under it.
  "  tokens: 400000",
  // Ten responses, two forty-second intervals and two real checks; the failing subject keeps a budget it must exceed.
  `  milliseconds: ${failure ? 30000 : 900000}`,
  "---", "",
  failure
    ? 'Read README.md in one cell and print its content. In the NEXT cell call bash with command "sleep 45" and timeoutMs 60000. Do not write any files. This subject intentionally exceeds its run budget. Do not finish early.'
    : [
      `The marker is the exact line ${JSON.stringify(marker)}. Append it to README.md, preserving all original bytes and adding one final newline.`,
      "Use one numbered step per model response, one JavaScript cell per step. Never combine steps in one response.",
      '1. Read README.md with ctx.call("read", {path:"README.md"}); save the returned content in a variable and print it. Do not write yet.',
      '2. In the next response call ctx.call("bash", {command:"sleep 40; echo interval-1", timeoutMs:110000}) and print the result. Do not write yet.',
      '3. In the next response call ctx.call("bash", {command:"sleep 40; echo interval-2", timeoutMs:110000}) and print the result. Do not write yet.',
      '4. In the next response call ctx.call("bash", {command:"bun test timeline-marker.test.ts", timeoutMs:110000}) and print the result. Its marker assertion must fail before the edit.',
      `5. In the next response use ctx.call("write", {path:"README.md", content: ...}) to append the exact line ${JSON.stringify(marker)} to the saved text. read.content omits its final LF, so append one newline before and after the marker.`,
      `6. In each of the next three responses write one of ${PIN_FILES.join(", ")} with ctx.call("write", {path:..., content:${JSON.stringify(`${marker}\n`)}}). These three files record the same marker. Use a separate response for each file.`,
      '7. In the next response run the exact same bun test command with timeoutMs 110000 and print the result. It must pass after the edit.',
      '8. In the next response read README.md again. Finish with ctx.done only if the exact marker line exists and the test passed.'
    ].join("\n")
].join("\n") + "\n"

const guardFlowText = [
  "---",
  "description: Park on a token guard so an operator decides Continue or Stop.",
  'capabilities: ["fs:read:**"]',
  "model: coding/implement",
  "budget:",
  "  tokens: 1",
  "  onExceeded: park",
  "---", "",
  "Read README.md in one cell, print its first line, then finish with ctx.done. Do not write any files."
].join("\n") + "\n"

export const readWorkspaceText = async (page: Page, request: APIRequestContext, repo: string, workspaceId: string, path: string): Promise<string> => {
  const response = await realApi(page, request, "GET", cloudRepoPath(repo,
    `/workspaces/${encodeURIComponent(workspaceId)}/files/content?path=${encodeURIComponent(path)}`))
  expect(response.status(), `workspace file ${path}`).toBe(200)
  const body = await response.json() as { content?: unknown; encoding?: unknown }
  expect(body.encoding).toBe("utf-8")
  expect(typeof body.content).toBe("string")
  return body.content as string
}

/** Await the new session's receipt; command submission alone does not replace the prior terminal. */
const openOwnedTerminal = async (page: Page, repo: string, workspaceId: string) => {
  type Session = { id: string; workspace_id: string }
  const sessions = async (): Promise<Session[]> => {
    const response = await realApi(page, page.request, "GET", cloudRepoPath(repo, "/workspace/sessions"))
    expect(response.status()).toBe(200)
    const body = await response.json()
    const rows: Session[] = Array.isArray(body) ? body : body.sessions ?? body.items
    expect(Array.isArray(rows)).toBe(true)
    return rows.filter(row => row.workspace_id === workspaceId)
  }
  const before = new Set((await sessions()).map(row => row.id))
  const created = page.waitForResponse(response => response.request().method() === "POST" &&
    new URL(response.url()).pathname === cloudRepoPath(repo, "/workspace/sessions") &&
    response.request().postDataJSON()?.workspace_id === workspaceId && response.status() === 201)
  void created.catch(() => undefined)
  await command(page, `/box.terminal ${workspaceId}`)
  await created
  let receipts: Session[] = []
  await expect.poll(async () => {
    receipts = (await sessions()).filter(row => !before.has(row.id))
    return receipts.length
  }, { timeout: 30000 }).toBe(1)
  const receipt = receipts[0]!
  expect(receipt.workspace_id).toBe(workspaceId)
  expect(receipt.id).toMatch(/^[0-9a-f-]{36}$/)
  await closeComposer(page)
  const terminal = page.getByTestId(`card-workspace-${workspaceId}`).getByTestId(`terminal-${receipt.id}`)
  await expect(terminal).toBeVisible({ timeout: 90000 })
  // The released terminal adapter retains its first stream when the session changes.
  // Reload mounts the measured session and exercises its persisted binding.
  await reloadApp(page)
  // The booted app still has to re-open this session's stream, which is the
  // same 90s budget the first mount is given, not the default assertion budget.
  await expect(terminal, "the measured terminal session must remount after the reload").toBeVisible({ timeout: 90000 })
  return { terminal, sessionId: receipt.id }
}

/** Measure after resume, using a new file so an earlier measurement cannot satisfy the readback. */
export const measureWorkspaceHost = async (page: Page, request: APIRequestContext, repo: string, workspaceId: string): Promise<{ sha256: string; workspaceRoot: string }> => {
  const path = `timeline-host.${crypto.randomUUID()}.txt`
  let sessionId: string | undefined
  try {
    const opened = await openOwnedTerminal(page, repo, workspaceId)
    const { terminal } = opened
    sessionId = opened.sessionId
    await terminal.locator(".xterm-helper-textarea").focus()
    await page.keyboard.insertText(`sha256sum /usr/local/bin/smithers-coding-host > ${path} && pwd -P >> ${path}`)
    await page.keyboard.press("Enter")
    let content = ""
    await expect(async () => {
      content = await readWorkspaceText(page, request, repo, workspaceId, path)
      expect(content).toMatch(/^[0-9a-f]{64} /)
      expect(content.split("\n")).toHaveLength(3)
      expect(content.split("\n")[1]?.startsWith("/")).toBe(true)
    }).toPass({ timeout: 45000 })
    return { sha256: content.split(" ")[0]!, workspaceRoot: content.split("\n")[1]! }
  } finally {
    if (sessionId !== undefined) {
      const response = await realApi(page, request, "POST", `${cloudRepoPath(repo, "/workspace/sessions")}/${encodeURIComponent(sessionId)}/destroy`)
      expect(response.status()).toBe(204)
    }
  }
}

/** Type real files through the PTY, then verify the bytes through the independent file API. */
export const writeSeededFlow = async (page: Page, request: APIRequestContext, repo: string, workspaceId: string, marker: string): Promise<void> => {
  const files = new Map([
    [`flows/${SEEDED_FLOW}/flow.mdx`, flowText(false, marker)],
    [`flows/${FAILED_FLOW}/flow.mdx`, flowText(true, marker)],
    [`flows/${GUARD_FLOW}/flow.mdx`, guardFlowText],
    // The live interval comes from the subject's own frames now, so this check
    // only has to be a real process that fails before the edit and passes after.
    [MARKER_TEST, `import {test, expect} from "bun:test";\nimport {readFileSync} from "node:fs";\ntest("exact marker line", async () => { await Bun.sleep(5000); expect(readFileSync("README.md", "utf8").split(/\\r?\\n/)).toContain(${JSON.stringify(marker)}); }, 60000);\n`]
  ])
  const sessions = cloudRepoPath(repo, "/workspace/sessions")
  let sessionId: string | undefined
  try {
    const opened = await openOwnedTerminal(page, repo, workspaceId)
    const { terminal } = opened
    sessionId = opened.sessionId
    await terminal.locator(".xterm-helper-textarea").focus()
    for (const [path, content] of files) {
      const encoded = Buffer.from(content).toString("base64")
      await page.keyboard.insertText(`mkdir -p flows/${SEEDED_FLOW} flows/${FAILED_FLOW} flows/${GUARD_FLOW}; printf %s '${encoded}' | base64 -d > '${path}'`)
      await page.keyboard.press("Enter")
      await expect(async () => expect(await readWorkspaceText(page, request, repo, workspaceId, path)).toBe(content)).toPass({ timeout: 45000 })
    }
  } finally {
    if (sessionId !== undefined) {
      const destroyed = await realApi(page, request, "POST", `${sessions}/${encodeURIComponent(sessionId)}/destroy`)
      expect(destroyed.status(), "the owned terminal is destroyed").toBe(204)
    }
  }
}

/** Suspends and resumes the workspace, so the host restarts and discovers the repository's flows. */
export const restartWorkspaceHost = async (page: Page, request: APIRequestContext, repo: string, workspaceId: string): Promise<void> => {
  const workspace = cloudRepoPath(repo, `/workspaces/${workspaceId}`)
  for (const [verb, settled] of [["suspend", "suspended"], ["resume", "running"]] as const) {
    await command(page, `/box.${verb} ${workspaceId}`)
    await closeComposer(page)
    await expect.poll(async () => {
      const response = await realApi(page, request, "GET", workspace)
      return response.status() === 200 ? String(((await response.json()) as { readonly status?: unknown }).status) : `http-${response.status()}`
      // A production resume has been measured past four minutes; the seeded subject needs the restarted host, not a shorter wait.
    }, { message: `the workspace must report ${settled}`, timeout: 420_000, intervals: [1_000, 2_000, 5_000] }).toBe(settled)
  }
}

/** One gateway read that reports a slow or refusing gateway as a value instead of throwing. */
const catalogOnce = async (page: Page, request: APIRequestContext, repo: string, workspaceId: string): Promise<ReadonlyArray<string> | undefined> => {
  try {
    const response = await realApi(page, request, "POST", "/api/workflow/rpc", { repo, procedure: "List", payload: { _tag: "flows" }, workspaceId })
    if (response.status() !== 200) return undefined
    const answer = await response.json() as { readonly ok?: boolean; readonly payload?: { readonly items?: ReadonlyArray<{ readonly flowId?: unknown }> } }
    if (answer.ok !== true) return undefined
    return (answer.payload?.items ?? []).flatMap((flow) => typeof flow.flowId === "string" ? [flow.flowId] : [])
  } catch {
    return undefined
  }
}

/**
 * Waits until the restarted host lists the seeded flow and then answers three
 * reads in a row. One good answer is not enough: the gateway flaps for minutes
 * after a resume, and a launch into a flap is refused upstream.
 */
export const awaitSeededFlow = async (page: Page, request: APIRequestContext, repo: string, workspaceId: string, flow = SEEDED_FLOW): Promise<void> => {
  let steady = 0
  await expect.poll(async () => {
    const flows = await catalogOnce(page, request, repo, workspaceId)
    steady = flows !== undefined && flows.includes(flow) ? steady + 1 : 0
    return steady
  }, { message: `the restarted host must list ${flow} three reads in a row`, timeout: 420_000, intervals: [5_000] }).toBeGreaterThanOrEqual(3)
}
