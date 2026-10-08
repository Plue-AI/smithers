import { registerKeyboardJourney, journeyTerminalInput } from "./support/keyboard-journey-input"
import { test, expect } from "@playwright/test"
import { scenario } from "./coverage/types"
import { command } from "./support/test"

// Reference-host acceptance: separate, freshly prepared S1 and S2 installs.
// No seeded card, intercepted route, guest double or qualification override.
const required = (key: string) => {
  const value = process.env[key]
  if (!value) throw new Error(`Reference-host precondition missing: ${key}`)
  return value
}

for (const stage of ["S1", "S1_NO_CONFIRM", "S2"] as const) test(`C-J6-01 ${stage} installed Claude skill and person confirmation`, scenario("journey.terminal-signin", { capabilities: ["install"], coverage: ["host:production", "host:local", "action:terminal", "door:slash", "path:success", "path:permission", "evidence:terminal-signin"] }), async ({ browser }, info) => {
  test.setTimeout(600_000)
  // Each phase has its own install and literal T1/T2 fixture. Never reuse S2
  // authority to qualify S1. Missing reference-host inputs fail the test.
  const fixture = (key: string) => required(`SMITHERS_TERMINAL_${stage}_${key}`)
  const context = await browser.newContext({ storageState: fixture("BEN_STATE") })
  const page = await context.newPage()
  const origin = new URL(fixture("ORIGIN")).origin
  const keys = process.env.SMITHERS_JOURNEY_KEYBOARD === "1" ? registerKeyboardJourney(page, origin) : undefined
  let output = ""
  const presence: unknown[] = []
  const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'"
  let sequence = 0
  const run = async (script: string) => {
    await journeyTerminalInput(page.locator(".terminal-view").last())
    const start = output.length
    const marker = `J6_${stage}_${++sequence}`
    // Split marker defeats PTY input echo; check completion from actual output.
    await page.keyboard.type(`${script}; printf '\\nJ6_${stage}_%s\\n' ${sequence}`)
    await page.keyboard.press("Enter")
    await expect.poll(() => output.slice(start), { timeout: 180_000 }).toMatch(new RegExp(`^${marker}\\r?$`, "m"))
    return output.slice(start)
  }
  const repository = fixture("REPOSITORY")
  const stack = async (): Promise<{ landedMain?: string; items: { number: number; title: string; stack_position: number }[] }> => {
    const response = await context.request.get(`${origin}/api/repos/${repository}/mythical`)
    expect(response.status()).toBe(200)
    return response.json()
  }
  const order = async () => (await stack()).items.slice().sort((a, b) => a.stack_position - b.stack_position).map(item => item.number)
  const confirmations = async (): Promise<{ id: string; state: string; kind: string; revision: string; payload: { effect?: unknown } }[]> => {
    const response = await context.request.get(`${origin}/api/confirmations`)
    expect(response.status()).toBe(200)
    return response.json()
  }
  const guestRequest = async (method: string, path: string, body: unknown, status: number, code: string) => {
    // Execute in the actual delegated guest. Never put bearer bytes in argv,
    // browser traffic, transcript, evidence or a second credential file.
    const script = `import json,os,urllib.request,urllib.error; token=open(os.environ['SMITHERS_TOKEN_FILE']).read().strip(); request=urllib.request.Request(os.environ['SMITHERS_URL'].rstrip('/')+${JSON.stringify(path)},data=${JSON.stringify(JSON.stringify(body))}.encode(),method=${JSON.stringify(method)},headers={'Authorization':'Bearer '+token,'Content-Type':'application/json','Idempotency-Key':'j6-'+${JSON.stringify(stage + "-" + String(sequence))}}); exec("try:\n response=urllib.request.urlopen(request)\nexcept urllib.error.HTTPError as error:\n response=error"); result=json.load(response); assert response.status==${status}, (response.status,result); assert result.get('class')=='permission' and result.get('code')==${JSON.stringify(code)}, result; print('J6'+'HTTP='+str(response.status)+' '+json.dumps(result))`
    const result = await run(`/usr/bin/python3 -c ${quote(script)}`)
    expect(result).toMatch(new RegExp(`^J6HTTP=${status} `, "m"))
    return result
  }
  page.on("websocket", socket => {
    if (socket.url().includes("/api/live")) socket.on("framereceived", frame => {
      const raw = typeof frame.payload === "string" ? frame.payload : frame.payload.toString("utf8")
      const message = JSON.parse(raw)
      if (message.data?.presence) presence.push(message.data.presence)
    })
    if (!socket.url().includes("/terminal")) return
    socket.on("framereceived", frame => { output += typeof frame.payload === "string" ? frame.payload : frame.payload.toString("utf8") })
  })
  try {
    await keys?.ready()
    await page.goto(fixture("ORIGIN"))
    const bootstrap = await context.request.get(`${origin}/api/bootstrap`)
    expect(bootstrap.status()).toBe(200)
    const installed = await bootstrap.json()
    expect(installed.buildSha).toBe(fixture("BUILD_SHA"))
    await info.attach("installed-version", { body: JSON.stringify({ stage, buildSha: installed.buildSha, version: installed.version }), contentType: "application/json" })
    if (keys) {
      const theme = required("SMITHERS_JOURNEY_THEME")
      expect(theme).toMatch(/^(light|dark)$/)
      if (await page.locator("html").getAttribute("data-theme") !== theme) await command(page, "/theme")
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme)
    }
    await command(page, "/branch T1")
    await command(page, `/terminal ${fixture("BRANCH")}`)
    await journeyTerminalInput(page.locator(".terminal-view").last())
    // Never print bearer bytes. Ownership, mode, path, CLI result and discovery
    // are inspected inside the real permanently unprivileged guest session.
    const uid = stage === "S2" ? fixture("BEN_UID") : "1500"
    expect(uid).toMatch(/^[1-9][0-9]*$/)
    const signIn = await run([
      `test "$(id -u)" = ${quote(uid)}`,
      `test "$(stat -c '%a %u' "$SMITHERS_TOKEN_FILE")" = ${quote(`600 ${uid}`)}`,
      'printf "%s\\n" "$SMITHERS_TOKEN_FILE"',
      'test "$(command -v smthrs)" = /opt/smithers/bundle/bin/linux-arm64/smthrs',
      'smthrs auth status --json',
      'test "$(readlink "$HOME/.claude/skills/smithers")" = /opt/smithers/bundle/share/skills/smithers',
      'test "$(readlink "$HOME/.agents/skills/smithers")" = /opt/smithers/bundle/share/skills/smithers',
      'grep -q "smthrs todo new" "$HOME/.agents/skills/smithers/SKILL.md"',
      "printf 'J6''SIGNIN=verified\\n'"
    ].join(" && "))
    expect(signIn).toMatch(/^J6SIGNIN=verified\r?$/m)
    const tokenPath = signIn.match(/^\/run\/smithers\/[^\r\n]+\/token\r?$/m)?.[0]?.trim()
    expect(tokenPath).toBeDefined()
    expect(tokenPath).toMatch(stage !== "S2" ? /^\/run\/smithers\/sessions\/[A-Za-z0-9_-]+\/token$/ : new RegExp(`^/run/smithers/${uid}/token/sessions/[A-Za-z0-9_-]+/token$`))
    expect(signIn).toMatch(/"(?:username|login)":\s*"ben"/)
    expect(signIn).toMatch(/"credential_kind":\s*"delegated"/)
    expect(signIn).toMatch(/"via":\s*"terminal"/)
    if (stage === "S2") {
      const privateDirectory = await run('stat -c "%a %u" "/run/smithers/$(id -u)/token"')
      expect(privateDirectory).toMatch(new RegExp(`^700 ${uid}\\r?$`, "m"))
    }
    expect(await order()).toEqual([1, 2])
    expect((await confirmations()).filter(row => row.state === "pending")).toEqual([])
    if (stage === "S1_NO_CONFIRM") {
      const refusal = await guestRequest("POST", "/api/todos", { title: "No consumer append", prompt: "No consumer append", place: { mode: "append" } }, 403, "confirm_in_app")
      expect(refusal).toContain("Confirm in the app")
      expect(await order()).toEqual([1, 2])
      expect(await confirmations()).toEqual([])
      await info.attach("s1-missing-consumer", { body: JSON.stringify({ stage, stack: await stack(), confirmations: await confirmations() }), contentType: "application/json" })
      return
    }
    const title = `J6 ${stage} skill follow-up`
    // Invoke Claude itself, with its installed skill and the member's existing
    // model login. CLI success text alone cannot prove persisted effects.
    const prompt = `Use the installed Smithers skill. Read the repository wiki. Answer T1's question ${fixture("WAIT")} with exactly Use backoff. Steer T1 with exactly Use the retry helper. Create one TODO titled ${title} with text Keep the terminal request private ${stage === "S1" ? "at Append" : "directly after T1"}. Do not approve anything. Report the structured command results.`
    const toolProof = "import json,sys; commands=[block.get('input',{}).get('command','') for line in sys.stdin for message in [json.loads(line)] for block in message.get('message',{}).get('content',[]) if isinstance(block,dict) and block.get('type')=='tool_use']; assert all(any('smthrs '+expected in command for command in commands) for expected in ['wiki','todo answer','todo steer','todo new']); print('J6'+'SKILL=executed')"
    const [agent] = await Promise.all([
      run(`claude -p ${quote(prompt)} --output-format stream-json --verbose | /usr/bin/python3 -c ${quote(toolProof)}`),
      (async () => {
        if (stage !== "S2") return
        const onBranch = page.getByRole("list", { name: "On this branch", exact: true }).last()
        await expect(onBranch.getByRole("img", { name: "Claude Code for Ben", exact: true })).toBeVisible({ timeout: 60_000 })
        await expect(onBranch.getByRole("img", { name: /Coding agent/ })).toBeVisible()
      })()
    ])
    expect(agent).toMatch(/^J6SKILL=executed\r?$/m)
    expect(agent).not.toMatch(/not logged in|login required|sign in to Smithers/i)
    await expect.poll(async () => (await confirmations()).filter(row => row.state === "pending").length).toBe(1)
    expect(await order()).toEqual([1, 2])
    const pending = (await confirmations()).filter(row => row.state === "pending")[0]!
    await guestRequest("POST", `/api/confirmations/${pending.id}/approve`, {}, 403, "permission")
    expect(await order()).toEqual([1, 2])
    expect(pending.kind).toBe("one_click")
    const card = page.locator('[data-kind="confirm"]').filter({ hasText: title })
    await expect(card).toBeVisible()
    await expect(card).toContainText("Claude Code for Ben")
    // Private card is absent for Alice. No mock live
    // topic supplies the person consumer or its approval response.
    const alice = await browser.newContext({ storageState: fixture("ALICE_STATE") })
    try {
      const other = await alice.newPage()
      await other.goto(fixture("ORIGIN"))
      await expect(other.getByTestId("composer-input")).toBeEnabled()
      await expect(other.locator('[data-kind="confirm"]').filter({ hasText: title })).toHaveCount(0)
      const privateRead = await alice.request.get(`${origin}/api/confirmations`)
      expect(privateRead.status()).toBe(200)
      expect(JSON.stringify(await privateRead.json())).not.toContain(pending.id)
      if (stage === "S2") {
        let otherOutput = ""
        other.on("websocket", socket => {
          if (socket.url().includes("/terminal")) socket.on("framereceived", frame => {
            otherOutput += typeof frame.payload === "string" ? frame.payload : frame.payload.toString("utf8")
          })
        })
        await command(other, `/terminal ${fixture("BRANCH")}`)
        await journeyTerminalInput(other.locator(".terminal-view").last())
        const eacces = `import errno,os; path=${JSON.stringify(tokenPath)}; exec("try:\n os.open(path,os.O_RDONLY)\nexcept OSError as error:\n assert error.errno == errno.EACCES\n print('J6'+'ISOLATION=EACCES')\nelse:\n raise AssertionError('Alice read Ben credential')")`
        await other.keyboard.type(`/usr/bin/python3 -c ${quote(eacces)}`)
        await other.keyboard.press("Enter")
        await expect.poll(() => otherOutput).toMatch(/^J6ISOLATION=EACCES\r?$/m)
      }
    } finally { await alice.close() }
    const approval = page.waitForResponse(response => response.url().endsWith(`/api/confirmations/${pending.id}/approve`) && response.request().method() === "POST")
    await card.locator('[data-flow="approval.approve"]').press("Enter")
    expect((await approval).status()).toBeGreaterThanOrEqual(200)
    expect((await approval).status()).toBeLessThan(300)
    await expect.poll(async () => (await stack()).items.filter(item => item.title === title).length).toBe(1)
    const created = (await stack()).items.find(item => item.title === title)!.number
    expect(await order()).toEqual(stage === "S1" ? [1, 2, created] : [1, created, 2])
    const activity = await context.request.get(`${origin}/api/branches/${encodeURIComponent(fixture("BRANCH"))}/activity`)
    expect(activity.status()).toBe(200)
    const facts = await activity.json()
    expect(JSON.stringify(facts)).toContain("claude-code")
    const entries = (facts as { actor: { kind: string; agent?: string; for_member?: { login: string }; id?: string; avatar_url?: string }; kind: string; text: string }[])
    for (const kind of ["answer", "steer"]) {
      const entry = entries.find(row => row.kind === kind && row.actor.agent === "claude-code")
      expect(entry).toBeDefined()
      expect(entry!.actor.kind).toBe("agent")
      expect(entry!.actor.for_member?.login).toBe("ben")
      expect(entry!.actor.id).toBeTruthy()
      expect(entry!.actor.avatar_url).toBeTruthy()
      expect(entry!.text).toContain(kind === "answer" ? "Use backoff" : "Use the retry helper")
    }
    if (stage === "S1") {
      for (const [path, payload] of [
        ["/api/secrets", { name: "J6_FORBIDDEN", value: "not-a-secret", scope: "all" }],
        ["/api/members", { login: "alice", role: "owner" }],
        ["/api/confirmations", { command: "todo.new", payload: { prompt: "Forbidden explicit confirmation" } }],
        ["/api/todos/1/answer", { wait: fixture("APPROVAL_WAIT"), answer: "approve" }]
      ] as const) {
        await guestRequest("POST", path, payload, 403, "permission")
        expect(await order()).toEqual([1, 2, created])
        expect((await confirmations()).filter(row => row.state === "pending")).toEqual([])
      }
      for (const forbidden of [
        "smthrs todo new --text forbidden --after T1",
        "smthrs stack move T1 down",
        "smthrs todo drop T1",
        `smthrs merge T1 --reviewed_head_sha ${quote(fixture("REVIEWED_SHA"))}`,
        "smthrs todo steer T2 forbidden"
      ]) {
        const refusal = await run(`${forbidden} --json`)
        expect(refusal).toMatch(/"class":\s*"permission"/)
        expect(refusal).toMatch(/"code":\s*"permission"/)
        expect(await order()).toEqual([1, 2, created])
      }
    } else {
      // A separate ready first TODO fixture is prepared by the reference host;
      // the test never forges passing checks or changes qualification gates.
      await run(`claude -p ${quote(`Use the Smithers skill to request merge of T1 at reviewed SHA ${fixture("REVIEWED_SHA")}. Do not approve it.`)} --output-format json`)
      const mergeCard = page.locator('[data-kind="confirm"]').filter({ hasText: `Merge T1 into main?` })
      await expect(mergeCard).toBeVisible()
      await expect(mergeCard).toContainText(fixture("REVIEWED_SHA"))
      const mergeRows = (await confirmations()).filter(row => row.state === "pending" && row.kind === "review_merge")
      expect(mergeRows).toHaveLength(1)
      expect(mergeRows[0]!.revision).toBe(fixture("REVIEWED_SHA"))
      expect(mergeRows[0]!.payload.effect).toBeUndefined()
      const before = await stack()
      const deny = page.waitForResponse(response => response.url().endsWith(`/api/confirmations/${mergeRows[0]!.id}/deny`) && response.request().method() === "POST")
      await mergeCard.locator('[data-flow="approval.deny"]').press("Enter")
      expect((await deny).ok()).toBe(true)
      await expect(mergeCard).toContainText("Cancelled")
      expect(await order()).toEqual(before.items.slice().sort((a, b) => a.stack_position - b.stack_position).map(item => item.number))
      expect((await stack()).landedMain).toBe(before.landedMain)
      const cancelled = (await confirmations()).find(row => row.id === mergeRows[0]!.id)!
      expect(cancelled.state).toBe("rejected")
      expect(cancelled.payload.effect).toBeUndefined()
      const agents = presence.flatMap(snapshot => snapshot as { actor: { kind: string; id: string; agent?: string; avatar_url?: string; for_member?: { login: string } } }[]).map(row => row.actor)
      const claude = agents.find(actor => actor.kind === "agent" && actor.agent === "claude-code" && actor.for_member?.login === "ben")
      const coding = agents.find(actor => actor.kind === "agent" && actor.agent === "coding")
      expect(claude).toBeDefined()
      expect(coding).toBeDefined()
      expect(claude!.id).not.toBe(coding!.id)
      expect(claude!.avatar_url).toBeTruthy()
      expect(claude!.avatar_url).not.toBe(coding!.avatar_url)
      await info.attach("s2-review-merge", { body: JSON.stringify({ mergeRows, before, after: await stack() }), contentType: "application/json" })
    }
    // A second real terminal holds A's delegated bytes only in test-process
    // memory before close, to exercise server revocation without recording a
    // bearer or creating a credential alias. B then uses its own packaged CLI.
    const second = await context.newPage()
    let secondOutput = ""
    second.on("websocket", socket => {
      if (socket.url().includes("/terminal")) socket.on("framereceived", frame => {
        secondOutput += typeof frame.payload === "string" ? frame.payload : frame.payload.toString("utf8")
      })
    })
    await second.goto(fixture("ORIGIN"))
    await command(second, `/terminal ${fixture("BRANCH")}`)
    await journeyTerminalInput(second.locator(".terminal-view").last())
    const reuse = [
      "import json,os,time,urllib.request,urllib.error",
      `token=open(${JSON.stringify(tokenPath)}).read().strip()`,
      "print('J6'+'REUSE=ready',flush=True)",
      "input()",
      "deadline=time.monotonic()+5",
      "while True:",
      " request=urllib.request.Request(os.environ['SMITHERS_URL'].rstrip('/')+'/api/user',headers={'Authorization':'Bearer '+token})",
      " try: response=urllib.request.urlopen(request)",
      " except urllib.error.HTTPError as error: response=error",
      " result=json.load(response)",
      " if response.status==401:",
      "  assert result.get('class')=='permission' and result.get('code')=='unauthenticated', result",
      "  print('J6'+'REVOKED=401',flush=True)",
      "  break",
      " assert time.monotonic()<deadline, 'Closed credential remained valid'",
      " time.sleep(0.1)"
    ].join("\n")
    await second.keyboard.type(`/usr/bin/python3 -c ${quote(reuse)}`)
    await second.keyboard.press("Enter")
    await expect.poll(() => secondOutput).toMatch(/^J6REUSE=ready\r?$/m)
    await journeyTerminalInput(page.locator(".terminal-view").last())
    const closingAt = Date.now()
    await page.keyboard.type("exit")
    await page.keyboard.press("Enter")
    await journeyTerminalInput(second.locator(".terminal-view").last())
    await second.keyboard.press("Enter")
    await expect.poll(() => secondOutput, { timeout: 5000 }).toMatch(/^J6REVOKED=401\r?$/m)
    expect(Date.now() - closingAt).toBeLessThanOrEqual(5000)
    await second.keyboard.type(`test ! -e ${quote(tokenPath!)} && smthrs auth status --json && printf 'J6''SECOND=valid\\n'`)
    await second.keyboard.press("Enter")
    await expect.poll(() => secondOutput).toMatch(/^J6SECOND=valid\r?$/m)
    expect(secondOutput).toMatch(/"username":\s*"ben"/)
    expect(secondOutput).toMatch(/"credential_kind":\s*"delegated"/)
    await second.keyboard.type("exit")
    await second.keyboard.press("Enter")
    await second.close()
    await info.attach(`${stage.toLowerCase()}-terminal-acceptance`, { body: JSON.stringify({ stage, stack: await stack(), confirmations: await confirmations(), activity: facts, presence }), contentType: "application/json" })
    await info.attach("redacted-guest-signin", { body: signIn, contentType: "text/plain" })
    await keys?.observe()
    keys?.finish()
  } finally {
    try {
      if (keys) await info.attach("terminal-keyboard", { body: JSON.stringify(keys.snapshot()), contentType: "application/json" })
    } finally { await context.close() }
  }
})
