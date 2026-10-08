import { test, expect } from "@playwright/test"
import { scenario } from "./coverage/types"
import { command } from "./support/test"

// Native C-J6-01 bundle/sign-in slice. No seeded card, route or guest double.
// Full Claude Code confirmation/presence acceptance additionally needs the
// member's model login and the reference-host confirmation fixture.
const required = (key: string) => {
  const value = process.env[key]
  if (!value) throw new Error(`Reference-host precondition missing: ${key}`)
  return value
}

test("C-J6-01 packaged guest CLI, discovered skill and delegated scope", scenario("journey.terminal-signin", { capabilities: ["install"], coverage: ["host:production", "host:local", "action:terminal", "door:slash", "path:success", "path:permission", "evidence:terminal-signin"] }), async ({ browser }, info) => {
  const context = await browser.newContext({ storageState: required("SMITHERS_TERMINAL_BEN_STATE") })
  const page = await context.newPage()
  let output = ""
  page.on("websocket", socket => {
    if (!socket.url().includes("/terminal")) return
    socket.on("framereceived", frame => { output += typeof frame.payload === "string" ? frame.payload : frame.payload.toString("utf8") })
  })
  try {
    await page.goto(required("SMITHERS_TERMINAL_ORIGIN"))
    await command(page, `/terminal ${required("SMITHERS_TERMINAL_BRANCH")}`)
    const field = page.locator(".terminal-view").last().locator(".xterm-helper-textarea")
    await field.focus()
    // Never print bearer bytes. Ownership, mode, path, CLI result and discovery
    // are inspected inside the real permanently unprivileged guest session.
    const script = [
      "id -u",
      'stat -c "%a %u" "$SMITHERS_TOKEN_FILE"',
      'printf "%s\\n" "$SMITHERS_TOKEN_FILE"',
      "command -v smthrs",
      "smthrs auth status --json",
      'test "$(readlink "$HOME/.claude/skills/smithers")" = /opt/smithers/bundle/share/skills/smithers',
      'test "$(readlink "$HOME/.agents/skills/smithers")" = /opt/smithers/bundle/share/skills/smithers',
      'grep -q "smthrs todo new" "$HOME/.agents/skills/smithers/SKILL.md"',
      "echo SMITHERS_SKILL_DISCOVERED",
      "smthrs todo drop T2 --json",
      "echo SMITHERS_SCOPE_COMPLETE"
    ].join(" && ")
    // A scope refusal deliberately exits nonzero, so its completion marker is
    // a separate shell command. None of the forbidden requests may take effect.
    await page.keyboard.type(script.replace(" && echo SMITHERS_SCOPE_COMPLETE", "; echo SMITHERS_SCOPE_COMPLETE"))
    await page.keyboard.press("Enter")
    await expect.poll(() => output, { timeout: 60_000 }).toMatch(/^SMITHERS_SCOPE_COMPLETE\r?$/m)
    expect(output).toContain(`/run/smithers/${required("SMITHERS_TERMINAL_BEN_UID")}/token/sessions/`)
    expect(output).toContain(`600 ${required("SMITHERS_TERMINAL_BEN_UID")}`)
    expect(output).toContain("/opt/smithers/bundle/bin/linux-arm64/smthrs")
    expect(output).toMatch(/"(?:username|login)":\s*"ben"/)
    expect(output).toMatch(/"credential_kind":\s*"delegated"/)
    expect(output).toMatch(/^SMITHERS_SKILL_DISCOVERED\r?$/m)
    expect(output).toMatch(/"class":\s*"permission"/)
    expect(output).toMatch(/"code":\s*"permission"/)
    await info.attach("redacted-guest-signin", { body: output, contentType: "text/plain" })
  } finally { await context.close() }
})
