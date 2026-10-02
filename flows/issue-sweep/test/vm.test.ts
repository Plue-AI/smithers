import { RunStore } from "@smthrs/run-store"
import { type MicrosandboxSandbox, Sandbox } from "@smthrs/sandbox"
import { Cause, Deferred, Effect, Exit, Fiber, Scope } from "effect"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { hostname } from "node:os"
import test from "node:test"
import {
  agentHosts,
  awaitDisk,
  guestCheckout,
  holderAlive,
  make,
  makeJob,
  niceWrapper,
  reapOrphans,
  refreshLine,
  sh,
  sizing
} from "../vm.ts"

const fakeFreeBytes = () => 100 * 1024 ** 3

type Event =
  | { readonly kind: "started"; readonly pid: number }
  | { readonly kind: "stdout" | "stderr"; readonly data: Uint8Array }
  | { readonly kind: "exited"; readonly code: number }

/** What a guest command answers: its output and exit, or `"hang"` to never exit. */
interface Command {
  readonly line: string
  readonly cwd: string
  readonly machine: string
  readonly pid: number
  readonly env: Record<string, string>
}

type Answer = { readonly stdout?: string; readonly stderr?: string; readonly code: number } | "hang"

/**
 * A Microsandbox SDK whose machines answer commands from `answer` and record
 * every create and destroy, so a test reads what the provider did to them.
 */
const fakeSdk = (
  answer: (line: string, command: Command) => Answer,
  snapshots = [{ name: "issue-sweep.aaa", createdAt: new Date(1) }],
  bootMs = 0,
  destroyMs = 0,
  destroyGate?: Promise<void>
) => {
  const boots = { now: 0, peak: 0 }
  const live = new Set<string>()
  const created: Array<Record<string, unknown>> = []
  const destroyed: Array<string> = []
  const destroying: Array<string> = []
  const lines: Array<string> = []
  const envs: Array<Record<string, string>> = []
  const killed: Array<string> = []
  const commands: Array<Command> = []
  const files = new Map<string, Uint8Array>()
  const configs = new Map<string, Record<string, unknown>>()
  let nextPid = 7
  // A guest kill script (`p=<pid>; ...`) ends every hanging command, as the guest's signal would.
  const hanging = new Map<number, () => void>()
  const builder = (name: string) => {
    const config: Record<string, unknown> = { name }
    const chain = new Proxy({}, {
      get: (_, key: string) =>
        key === "create"
          ? async () => {
            if (live.has(name)) throw Object.assign(new Error("exists"), { code: "sandboxAlreadyExists" })
            configs.set(name, config)
            boots.peak = Math.max(boots.peak, ++boots.now)
            await new Promise((resolve) => setTimeout(resolve, bootMs))
            boots.now--
            created.push(config)
            live.add(name)
            return machine(name)
          }
          : (value: unknown) => {
            config[key] = typeof value === "function"
              ? (value as (b: unknown) => unknown)({ policy: (p: unknown) => (config.policy = p) })
              : value
            return chain
          }
    })
    return chain
  }
  const machine = (name: string) => ({
    name,
    backendKind: "local" as const,
    status: "running",
    get configJson() {
      return JSON.stringify(configs.get(name))
    },
    connect: async () => machine(name),
    start: async () => machine(name),
    startDetached: async () => machine(name),
    refresh: async () => machine(name),
    modify: async ({ labels }: { labels: Record<string, string> }) => {
      const config = configs.get(name)!
      config.labels = { ...(config.labels as Record<string, string>), ...labels }
      return { applied: true }
    },
    fs: () => ({
      mkdir: async () => undefined,
      write: async (path: string, content: Uint8Array) => {
        files.set(`${name}:${path}`, content.slice())
      },
      read: async (path: string) => files.get(`${name}:${path}`)?.slice() ?? new Uint8Array(),
      readToString: async () => name
    }),
    execStreamWith: async (program: string, configure: (b: unknown) => unknown) => {
      const call = { args: [] as Array<string>, envs: {} as Record<string, string>, cwd: "" }
      const b = {
        args: (a: Array<string>) => (call.args = a, b),
        cwd: (cwd: string) => (call.cwd = cwd, b),
        envs: (vars: Record<string, string>) => (call.envs = vars, b),
        stdinBytes: () => b
      }
      configure(b)
      const line = [program, ...call.args].join(" ")
      lines.push(line)
      envs.push(call.envs)
      const pid = nextPid++
      const command = { line, cwd: call.cwd, machine: name, pid, env: call.envs }
      commands.push(command)
      const kill = /p=(\d+);/.exec(line)
      if (kill) {
        killed.push(line)
        hanging.get(Number(kill[1]))?.()
      }
      const reply = answer(line, command)
      const events: Array<Event | null> = [{ kind: "started", pid }]
      if (reply !== "hang") {
        if (reply.stdout) events.push({ kind: "stdout", data: new TextEncoder().encode(reply.stdout) })
        if (reply.stderr) events.push({ kind: "stderr", data: new TextEncoder().encode(reply.stderr) })
        events.push({ kind: "exited", code: reply.code }, null)
      }
      let wake: (() => void) | undefined
      let ended = false
      if (reply === "hang") {
        const end = () => {
          hanging.delete(pid)
          events.push({ kind: "exited", code: 143 }, null)
          wake?.()
        }
        hanging.set(pid, end)
      }
      return {
        recv: async () => {
          while (events.length === 0 && !ended) await new Promise<void>((resolve) => (wake = resolve))
          return events.shift() ?? null
        },
        signal: async () => undefined,
        kill: async () => {
          ended = true
          wake?.()
        }
      }
    },
    destroy: async () => {
      destroying.push(name)
      if (destroyGate) await destroyGate
      if (destroyMs > 0) await new Promise((resolve) => setTimeout(resolve, destroyMs))
      destroyed.push(name)
      live.delete(name)
    }
  })
  const sdk = {
    Sandbox: {
      builder,
      get: async (name: string) => {
        if (live.has(name)) return machine(name)
        throw Object.assign(new Error(`sandbox not found: ${name}`), { code: "sandboxNotFound" })
      },
      listWith: async (configure: (list: unknown) => unknown) => {
        const labels: Record<string, string> = {}
        const query = { label: (key: string, value: string) => (labels[key] = value, query), cursor: () => query }
        configure(query)
        return {
          sandboxes: [...live].filter((name) => {
            const recorded = configs.get(name)?.labels as Record<string, string>
            return Object.entries(labels).every(([key, value]) => recorded?.[key] === value)
          }).map(machine)
        }
      }
    },
    Snapshot: { get: async () => snapshots[0], list: async () => snapshots, remove: async () => undefined },
    defaultBackendKind: () => "local" as const,
    setDefaultBackend: () => undefined
  } as unknown as MicrosandboxSandbox.Sdk
  return { sdk, live, created, destroyed, lines, envs, killed, boots, commands, destroying }
}

const ok: Answer = { code: 0 }

test("acquire boots the newest issue-sweep snapshot at the Cloud checkout path and refreshes main", async () => {
  const fake = fakeSdk((line) => line.includes("whoami") ? { stdout: "root\n", code: 0 } : ok, [
    { name: "issue-sweep.old", createdAt: new Date(1) },
    { name: "other.new", createdAt: new Date(3) },
    { name: "issue-sweep.new", createdAt: new Date(2) }
  ])
  const provider = make({ sdk: fake.sdk, freeBytes: fakeFreeBytes, holder: "test:1" })
  const result = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const session = yield* provider.acquire("issue-sweep:smithersai/smithers#1")
    assert.deepEqual([...fake.live], [session.remoteId])
    return { workdir: session.workdir, whoami: (yield* sh(session, "whoami")).stdout }
  })))
  assert.deepEqual(result, { workdir: guestCheckout, whoami: "root\n" })
  assert.equal(fake.created.length, 1)
  assert.equal(fake.created[0]!.fromSnapshot, "issue-sweep.new")
  assert.equal(fake.created[0]!.cpus, 2)
  assert.equal(fake.created[0]!.memory, 4096)
  const policy = fake.created[0]!.policy as {
    defaultEgress: string
    rules: Array<{ destination: { domain?: string } }>
  }
  assert.equal(policy.defaultEgress, "deny")
  assert.ok(policy.rules.some((rule) => rule.destination.domain === "github.com"))
  assert.ok(fake.lines.some((line) => line.includes(refreshLine)), "the checkout moves to current main")
  // #3321: agents ran Go and Cargo commands that were not on PATH.
  const env = fake.envs[fake.lines.findIndex((line) => line.includes(refreshLine))] ?? {}
  assert.match(env["PATH"] ?? "", /^\/usr\/local\/go\/bin:\/home\/developer\/workspace\/\.cache\/cargo\/bin:/)
  assert.equal(env["GOTOOLCHAIN"], "local", "go never downloads a toolchain")
  assert.equal(env["GOCACHE"], `${guestCheckout}/.cache/go-build`, "caches stay writable inside the checkout")
  assert.deepEqual([...fake.live], [], "the microVM is removed when the scope closes")
  assert.equal(fake.destroyed.length, 1)
  assert.equal(agentHosts.includes("example.com"), false)
})

test("a failed refresh fails the acquire with the guest's words, removes the microVM and frees its slot", async () => {
  const fake = fakeSdk((line) => line.includes("jj git fetch") ? { stderr: "fetch refused", code: 1 } : ok)
  const provider = make({ sdk: fake.sdk, freeBytes: fakeFreeBytes, maxVms: 1, holder: "test:1" })
  const exit = await Effect.runPromiseExit(Effect.scoped(provider.acquire("one")))
  assert.ok(Exit.isFailure(exit))
  assert.match(Cause.pretty(exit.cause), /refreshing the checkout exited 1: fetch refused/)
  assert.equal(fake.created.length, 1)
  assert.deepEqual([...fake.live], [])
  assert.equal(await Effect.runPromise(provider.slots.takeIfAvailable(1)), true, "the slot came back")
})

test("a failing body still removes its microVM", async () => {
  const fake = fakeSdk(() => ok)
  const provider = make({ sdk: fake.sdk, freeBytes: fakeFreeBytes, holder: "test:1" })
  const exit = await Effect.runPromiseExit(Effect.scoped(Effect.gen(function*() {
    yield* provider.acquire("body-fails")
    return yield* Effect.fail("agent failed")
  })))
  assert.ok(Exit.isFailure(exit))
  assert.equal(fake.destroyed.length, 1)
  assert.deepEqual([...fake.live], [])
})

test("interrupting a running guest command kills it, removes the microVM and frees the slot", async () => {
  const fake = fakeSdk((line) => line.includes("sleep") ? "hang" : ok)
  const provider = make({ sdk: fake.sdk, freeBytes: fakeFreeBytes, maxVms: 1, holder: "test:1" })
  const running = await Effect.runPromise(Deferred.make<void>())
  const fiber = Effect.runFork(Effect.scoped(Effect.gen(function*() {
    const session = yield* provider.acquire("interrupted")
    yield* Deferred.succeed(running, undefined)
    return yield* sh(session, "sleep 1000")
  })))
  await Effect.runPromise(Deferred.await(running))
  await new Promise((resolve) => setTimeout(resolve, 20))
  await Effect.runPromise(Fiber.interrupt(fiber))
  assert.ok(fake.killed.some((line) => line.includes("TERM")), "the command's process tree got SIGTERM")
  assert.deepEqual([...fake.live], [])
  assert.equal(await Effect.runPromise(provider.slots.takeIfAvailable(1)), true, "the slot came back")
})

test("maxVms queues an acquire until a slot frees", async () => {
  const fake = fakeSdk(() => ok)
  const provider = make({ sdk: fake.sdk, freeBytes: fakeFreeBytes, maxVms: 1, refresh: false, holder: "test:1" })
  const release = await Effect.runPromise(Deferred.make<void>())
  const first = Effect.runFork(Effect.scoped(Effect.andThen(provider.acquire("a"), Deferred.await(release))))
  await new Promise((resolve) => setTimeout(resolve, 20))
  const second = Effect.runFork(Effect.scoped(Effect.asVoid(provider.acquire("b"))))
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(fake.created.length, 1, "the second acquire waits for the first scope")
  await Effect.runPromise(Deferred.succeed(release, undefined))
  await Effect.runPromise(Fiber.join(first))
  await Effect.runPromise(Fiber.join(second))
  assert.equal(fake.created.length, 2)
  assert.deepEqual([...fake.live], [])
})

test("without a snapshot the acquire names the build command and boots nothing", async () => {
  const fake = fakeSdk(() => ok, [])
  const exit = await Effect.runPromiseExit(
    Effect.scoped(make({ sdk: fake.sdk, freeBytes: fakeFreeBytes, holder: "test:1" }).acquire("x"))
  )
  assert.ok(Exit.isFailure(exit))
  assert.match(Cause.pretty(exit.cause), /vm-image\.ts/)
  assert.equal(fake.created.length, 0)
})

test("holderAlive: this process lives, a dead pid does not, another host's holder is left alone", () => {
  assert.equal(holderAlive(`${hostname()}:${process.pid}`), true)
  const dead = Number(execFileSync("sh", ["-c", "sh -c 'echo $$' "], { encoding: "utf8" }).trim())
  assert.equal(holderAlive(`${hostname()}:${dead}`), false)
  assert.equal(holderAlive(`another-host:${dead}`), true)
})

test("bootConcurrency boots at most that many microVMs at once while maxVms admits more", async () => {
  const fake = fakeSdk(() => ok, undefined, 10)
  const provider = make({
    sdk: fake.sdk,
    freeBytes: fakeFreeBytes,

    maxVms: 6,
    bootConcurrency: 2,
    refresh: false,
    holder: "test:1"
  })
  await Effect.runPromise(Effect.forEach(
    [1, 2, 3, 4, 5, 6],
    (index) => Effect.scoped(Effect.asVoid(provider.acquire(`boot-${index}`))),
    { concurrency: "unbounded" }
  ))
  assert.equal(fake.boots.peak, 2)
  assert.equal(fake.created.length, 6)
  assert.deepEqual([...fake.live], [])
})

// #3328: busy guests starved the flow host's run-lease heartbeat and parked the sweep.
test("microVMs run through the nice wrapper at nice 10, below the flow host", () => {
  assert.equal(process.env.MSB_PATH, niceWrapper)
  const real = process.env.ISSUE_SWEEP_MSB ?? ""
  assert.match(real, /microsandbox-.*\/bin\/msb$/)
  const nice = execFileSync(niceWrapper, ["-c", "ps -o nice= -p $$"], {
    encoding: "utf8",
    env: { ...process.env, ISSUE_SWEEP_MSB: "/bin/sh" }
  }).trim()
  assert.equal(Number(nice), 10)
})

// run-4: 23 guests took the host from 46 to 20 GiB free in half an hour.
test("a microVM waits to boot while the host disk is below the floor", async () => {
  let free = 10
  let polls = 0
  let done = false
  const fiber = Effect.runFork(
    awaitDisk(() => (polls++, free), 20, "5 millis").pipe(
      Effect.andThen(Effect.sync(() => {
        done = true
      }))
    )
  )
  await Effect.runPromise(Effect.sleep("40 millis"))
  assert.equal(done, false, "still waiting below the floor")
  assert.ok(polls > 1, "it polls again")
  free = 30
  await Effect.runPromise(Fiber.join(fiber))
  assert.equal(done, true)
  const fake = fakeSdk(() => ok)
  const provider = make({ sdk: fake.sdk, holder: "test:1", freeBytes: () => 0, minFreeBytes: 1 })
  const waiting = Effect.runFork(Effect.scoped(provider.acquire("disk")))
  await Effect.runPromise(Effect.sleep("40 millis"))
  assert.equal(fake.created.length, 0, "acquire boots nothing below the floor")
  await Effect.runPromise(Fiber.interrupt(waiting))
})

const held = async (provider: ReturnType<typeof make>, key: string) => {
  const scope = await Effect.runPromise(Scope.make())
  const session = await Effect.runPromise(provider.acquire(key).pipe(Effect.provideService(Scope.Scope, scope)))
  return { session, close: () => Effect.runPromise(Scope.close(scope, Exit.void)) }
}

test("three agents share a microVM with separate working directories, homes and captured work", async () => {
  const base = "a".repeat(40)
  const patches = new Map<string, string>()
  const fake = fakeSdk((line, command) => {
    if (line.includes("SMITHERS_REVISION")) return { code: 0, stdout: base }
    if (line.includes("SMITHERS_BASE")) return { code: 0, stdout: patches.get(command.cwd) ?? "" }
    return ok
  })
  const provider = make({ sdk: fake.sdk, freeBytes: fakeFreeBytes, agentsPerVm: 3, maxVms: 1, refresh: false })
  const agents = await Promise.all(["one", "two", "three"].map((key) => held(provider, key)))
  try {
    assert.equal(fake.created.length, 1)
    assert.equal(new Set(agents.map(({ session }) => session.remoteId)).size, 1)
    assert.equal(new Set(agents.map(({ session }) => session.workdir)).size, 3)
    for (const [i, { session }] of agents.entries()) {
      await Effect.runPromise(sh(session, `agent-${i}`))
      patches.set(session.workdir, `diff --git a/agent-${i} b/agent-${i}\n`)
      const work = await Effect.runPromise(Sandbox.capture(session, { base }))
      assert.equal(work._tag, "Changed")
      if (work._tag === "Changed") assert.equal(work.patch, patches.get(session.workdir))
      assert.equal(work.session, session.id)
    }
    for (const [i, { session }] of agents.entries()) {
      const home = fake.commands.find(({ line }) => line.endsWith(`agent-${i}`))!.env.HOME!
      await Effect.runPromise(session.writeFile(`${home}/.codex/auth.json`, new TextEncoder().encode(`login-${i}`)))
    }
    for (const [i, { session }] of agents.entries()) {
      const home = fake.commands.find(({ line }) => line.endsWith(`agent-${i}`))!.env.HOME!
      assert.equal(
        new TextDecoder().decode(await Effect.runPromise(session.readFile(`${home}/.codex/auth.json`))),
        `login-${i}`
      )
    }
    const commands = fake.commands.filter(({ line }) => /agent-\d$/.test(line))
    assert.equal(commands.length, 3)
    assert.equal(new Set(commands.map(({ env }) => env.HOME)).size, 3)
    assert.equal(new Set(commands.map(({ env }) => env.XDG_CONFIG_HOME)).size, 3)
    assert.deepEqual(commands.map(({ cwd }) => cwd), agents.map(({ session }) => session.workdir))
    await agents[1]!.close()
    assert.equal(fake.destroyed.length, 0, "closing one agent leaves siblings alive")
    await agents[0]!.close()
    assert.equal(fake.destroyed.length, 0)
    await agents[2]!.close()
    assert.equal(fake.destroyed.length, 1, "the last close destroys the VM exactly once")
    assert.equal(await Effect.runPromise(provider.slots.takeIfAvailable(1)), true)
  } finally {
    await Promise.all(agents.map((agent) => agent.close()))
  }
})

test("a full shared VM queues the next agent until capacity is released", async () => {
  const fake = fakeSdk(() => ok)
  const provider = make({ sdk: fake.sdk, freeBytes: fakeFreeBytes, agentsPerVm: 2, maxVms: 1, refresh: false })
  const first = await held(provider, "first")
  const second = await held(provider, "second")
  const ready = await Effect.runPromise(Deferred.make<void>())
  const release = await Effect.runPromise(Deferred.make<void>())
  const queued = Effect.runFork(Effect.scoped(Effect.gen(function*() {
    yield* provider.acquire("queued")
    yield* Deferred.succeed(ready, undefined)
    yield* Deferred.await(release)
  })))
  try {
    await Effect.runPromise(Effect.sleep("30 millis"))
    assert.equal(await Effect.runPromise(Deferred.isDone(ready)), false)
    assert.equal(fake.created.length, 1)
    await first.close()
    await Effect.runPromise(Deferred.await(ready).pipe(Effect.timeout("2 seconds")))
    assert.equal(fake.created.length, 1, "the queued agent uses the still-live VM")
    assert.equal(fake.destroyed.length, 0)
    await second.close()
    assert.equal(fake.destroyed.length, 0)
    await Effect.runPromise(Deferred.succeed(release, undefined))
    await Effect.runPromise(Fiber.join(queued))
    assert.equal(fake.destroyed.length, 1)
  } finally {
    await Effect.runPromise(Fiber.interrupt(queued))
    await first.close()
    await second.close()
  }
})

test("interrupting one agent kills only its command and keeps its sibling usable", async () => {
  const fake = fakeSdk((line) => line.includes("sleep 1000") ? "hang" : ok)
  const provider = make({ sdk: fake.sdk, freeBytes: fakeFreeBytes, agentsPerVm: 2, maxVms: 1, refresh: false })
  const sibling = await held(provider, "sibling")
  const running = await Effect.runPromise(Deferred.make<void>())
  const fiber = Effect.runFork(Effect.scoped(Effect.gen(function*() {
    const session = yield* provider.acquire("interrupted-sibling")
    yield* Deferred.succeed(running, undefined)
    yield* sh(session, "sleep 1000")
  })))
  try {
    await Effect.runPromise(Deferred.await(running))
    await Effect.runPromise(Effect.sleep("20 millis"))
    await Effect.runPromise(Fiber.interrupt(fiber))
    assert.equal(fake.destroyed.length, 0)
    const sleep = fake.commands.find(({ line }) => line.includes("sleep 1000"))!
    assert.ok(fake.killed.some((line) => line.includes(`p=${sleep.pid};`)))
    assert.equal((await Effect.runPromise(sh(sibling.session, "echo alive"))).code, 0)
  } finally {
    await Effect.runPromise(Fiber.interrupt(fiber))
    await sibling.close()
  }
  assert.equal(fake.destroyed.length, 1)
})

test("default agentsPerVm keeps each concurrent session on its own VM", async () => {
  const fake = fakeSdk(() => ok)
  const provider = make({ sdk: fake.sdk, freeBytes: fakeFreeBytes, maxVms: 2, refresh: false })
  const agents = await Promise.all([held(provider, "default-a"), held(provider, "default-b")])
  try {
    assert.equal(fake.created.length, 2)
    assert.notEqual(agents[0]!.session.remoteId, agents[1]!.session.remoteId)
    assert.equal(agents[0]!.session.workdir, guestCheckout)
    assert.equal(agents[1]!.session.workdir, guestCheckout)
  } finally {
    await Promise.all(agents.map((agent) => agent.close()))
  }
  assert.equal(fake.destroyed.length, 2)
})

test("workspace preparation failure releases only that agent and a subsequent acquire recovers", async () => {
  let failed = false
  const fake = fakeSdk((line) => {
    if (line.includes("git clone --shared") && failed) return { code: 1, stderr: "workspace install refused" }
    return ok
  })
  const provider = make({ sdk: fake.sdk, freeBytes: fakeFreeBytes, agentsPerVm: 2, maxVms: 1, refresh: false })
  const survivor = await held(provider, "survivor")
  try {
    failed = true
    const exit = await Effect.runPromiseExit(Effect.scoped(provider.acquire("failed")))
    assert.ok(Exit.isFailure(exit))
    assert.match(Cause.pretty(exit.cause), /workspace install refused/)
    assert.equal(fake.destroyed.length, 0)
    assert.equal((await Effect.runPromise(sh(survivor.session, "echo still-alive"))).code, 0)
    failed = false
    const recovered = await held(provider, "recovered")
    assert.equal(fake.created.length, 1)
    assert.notEqual(recovered.session.workdir, survivor.session.workdir)
    await recovered.close()
    assert.equal(fake.destroyed.length, 0)
  } finally {
    await survivor.close()
  }
  assert.equal(fake.destroyed.length, 1)
  assert.ok(fake.lines.some((line) => line.includes("cgroup.kill")), "failed workspace cleanup runs")
})

test("maxAgents bounds sessions even when the VM has vacant capacity", async () => {
  const fake = fakeSdk(() => ok)
  const provider = make({
    sdk: fake.sdk,
    freeBytes: fakeFreeBytes,
    agentsPerVm: 3,
    maxAgents: 1,
    maxVms: 2,
    refresh: false
  })
  const first = await held(provider, "limited-first")
  const ready = await Effect.runPromise(Deferred.make<void>())
  const queued = Effect.runFork(Effect.scoped(Effect.gen(function*() {
    yield* provider.acquire("limited-second")
    yield* Deferred.succeed(ready, undefined)
  })))
  try {
    await Effect.runPromise(Effect.sleep("20 millis"))
    assert.equal(await Effect.runPromise(Deferred.isDone(ready)), false)
    assert.equal(fake.created.length, 1)
    await first.close()
    await Effect.runPromise(Fiber.join(queued).pipe(Effect.timeout("2 seconds")))
    assert.equal(await Effect.runPromise(Deferred.isDone(ready)), true)
    assert.deepEqual([...fake.live], [])
  } finally {
    await Effect.runPromise(Fiber.interrupt(queued))
    await first.close()
  }
})

test("shared VM sizing scales with agents and explicit CPU overrides retain the isolation memory floor", async () => {
  const fake = fakeSdk(() => ok)
  const provider = make({ sdk: fake.sdk, freeBytes: fakeFreeBytes, agentsPerVm: 3, maxVms: 1, cpus: 5, refresh: false })
  await Effect.runPromise(Effect.scoped(provider.acquire("sizing")))
  assert.equal(fake.created[0]!.cpus, 5)
  assert.equal(fake.created[0]!.memory, 10240)
  assert.ok(fake.lines.some((line) => line.includes("echo 3221225472 >") && line.includes("memory.max")))
  assert.ok(fake.lines.some((line) => line.includes("memory.oom.group")))
  assert.throws(() => make({ agentsPerVm: 3, memoryMib: 4096 }), /memory/i)
  for (const agentsPerVm of [0, -1, 1.5, NaN, Infinity]) {
    assert.throws(() => make({ agentsPerVm }), /agentsPerVm/)
  }
})

test("shared dependency install enters the agent OOM boundary before cloning or installing", async () => {
  const fake = fakeSdk(() => ok)
  await Effect.runPromise(
    Effect.scoped(
      make({ sdk: fake.sdk, freeBytes: fakeFreeBytes, agentsPerVm: 2, refresh: false }).acquire("oom-boundary")
    )
  )
  const prepare = fake.lines.find((line) => line.includes("git clone --shared"))!
  assert.ok(prepare.indexOf("memory.max") < prepare.indexOf("echo $$ >"))
  assert.ok(prepare.indexOf("echo $$ >") < prepare.indexOf("git clone --shared"))
  assert.ok(prepare.indexOf("echo $$ >") < prepare.indexOf("pnpm install"))
  const cleanup = fake.lines.find((line) => line.includes("cgroup.kill"))!
  assert.ok(cleanup.indexOf("cgroup.kill") < cleanup.indexOf("until rmdir"))
  assert.match(cleanup, /sleep 0\.1/)
})

test("interrupting the shared boot publisher releases waiting neighbors and all permits", async () => {
  const fake = fakeSdk(() => ok, undefined, 100)
  const provider = make({ sdk: fake.sdk, freeBytes: fakeFreeBytes, agentsPerVm: 3, maxVms: 1, refresh: false })
  const leader = Effect.runFork(Effect.scoped(provider.acquire("boot-leader")))
  await Effect.runPromise(Effect.sleep("10 millis"))
  const waiter = Effect.runFork(Effect.scoped(provider.acquire("boot-waiter")))
  await Effect.runPromise(Effect.sleep("10 millis"))
  await Effect.runPromise(Fiber.interrupt(leader))
  const result = await Effect.runPromise(Fiber.await(waiter).pipe(Effect.timeout("2 seconds")))
  assert.ok(Exit.isFailure(result))
  assert.deepEqual([...fake.live], [])
  assert.equal(await Effect.runPromise(provider.slots.takeIfAvailable(3)), true)
})

test("a missing shared snapshot fails all boot waiters without leaking permits", async () => {
  const fake = fakeSdk(() => ok, [])
  const provider = make({ sdk: fake.sdk, freeBytes: fakeFreeBytes, agentsPerVm: 3, maxVms: 1 })
  const exits = await Promise.all(
    ["one", "two", "three"].map((key) => Effect.runPromiseExit(Effect.scoped(provider.acquire(key))))
  )
  for (const exit of exits) {
    assert.ok(Exit.isFailure(exit))
    assert.match(Cause.pretty(exit.cause), /vm-image/)
  }
  assert.equal(fake.created.length, 0)
  assert.equal(await Effect.runPromise(provider.slots.takeIfAvailable(3)), true)
})

test("fragmented shared VM leases reuse capacity while respecting the physical VM cap", async () => {
  const fake = fakeSdk(() => ok)
  const provider = make({
    sdk: fake.sdk,
    freeBytes: fakeFreeBytes,
    agentsPerVm: 3,
    maxVms: 2,
    maxAgents: 6,
    refresh: false
  })
  const agents = await Promise.all(Array.from({ length: 6 }, (_, i) => held(provider, `fragment-${i}`)))
  try {
    assert.equal(fake.live.size, 2)
    const keep = new Set<string>()
    for (const agent of agents) {
      if (keep.has(agent.session.remoteId)) await agent.close()
      else keep.add(agent.session.remoteId)
    }
    assert.equal(fake.live.size, 2)
    const replacements = await Promise.all(Array.from({ length: 4 }, (_, i) => held(provider, `replacement-${i}`)))
    try {
      assert.equal(fake.created.length, 2, "fragmentation does not boot an extra physical machine")
      assert.equal(fake.live.size, 2)
      assert.equal(new Set([...agents, ...replacements].map(({ session }) => session.workdir)).size, 10)
    } finally {
      await Promise.all(replacements.map((agent) => agent.close()))
    }
  } finally {
    await Promise.all(agents.map((agent) => agent.close()))
  }
  assert.equal(fake.destroyed.length, 2)
})

test("sizing validates every capacity knob and honors CPU and memory boundaries", () => {
  for (
    const key of [
      "agentsPerVm",
      "maxAgents",
      "maxVms",
      "bootConcurrency",
      "memoryBaseMib",
      "memoryPerAgentMib",
      "memoryMib",
      "cpus",
      "cpusPerAgent",
      "maxCpus"
    ] as const
  ) {
    for (const value of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => sizing({ [key]: value }), new RegExp(key))
    }
  }
  assert.deepEqual(sizing(), { agentsPerVm: 1, memoryPerAgentMib: 3072, memoryMib: 4096, cpus: 2 })
  assert.equal(sizing({ agentsPerVm: 10 }).cpus, 8)
  assert.equal(sizing({ agentsPerVm: 3, cpusPerAgent: 2, maxCpus: 6 }).cpus, 6)
  assert.equal(sizing({ agentsPerVm: 3, cpus: 2 }).cpus, 2)
  assert.equal(sizing({ agentsPerVm: 3, memoryBaseMib: 512, memoryPerAgentMib: 1024, memoryMib: 3584 }).memoryMib, 3584)
  assert.throws(
    () => sizing({ agentsPerVm: 3, memoryBaseMib: 512, memoryPerAgentMib: 1024, memoryMib: 3583 }),
    /memoryMib/
  )
})

test("maxVms includes machines whose last agent is still tearing down", async () => {
  let finishDestroy!: () => void
  const destroyGate = new Promise<void>((resolve) => {
    finishDestroy = resolve
  })
  const fake = fakeSdk(() => ok, undefined, 0, 0, destroyGate)
  const provider = make({
    sdk: fake.sdk,
    freeBytes: fakeFreeBytes,
    agentsPerVm: 3,
    maxAgents: 6,
    maxVms: 2,
    refresh: false
  })
  const agents = await Promise.all(Array.from({ length: 6 }, (_, i) => held(provider, `teardown-${i}`)))
  const retiring = agents.filter((agent) => agent.session.remoteId === agents[0]!.session.remoteId)
  await retiring[0]!.close()
  await retiring[1]!.close()
  const closing = retiring[2]!.close()
  await Effect.runPromise(
    Effect.gen(function*() {
      while (fake.destroying.length === 0) yield* Effect.sleep("1 millis")
    }).pipe(Effect.timeout("2 seconds"))
  )
  const ready = await Effect.runPromise(Deferred.make<void>())
  const replacement = Effect.runFork(Effect.scoped(Effect.gen(function*() {
    yield* provider.acquire("during-teardown")
    yield* Deferred.succeed(ready, undefined)
  })))
  try {
    await Effect.runPromise(Effect.sleep("20 millis"))
    assert.equal(await Effect.runPromise(Deferred.isDone(ready)), false)
    assert.equal(fake.created.length, 2, "replacement cannot boot before the retiring VM is destroyed")
    finishDestroy()
    await closing
    await Effect.runPromise(Fiber.join(replacement).pipe(Effect.timeout("2 seconds")))
    assert.equal(fake.created.length, 3)
  } finally {
    finishDestroy()
    await Effect.runPromise(Fiber.interrupt(replacement))
    await closing
    await Promise.all(agents.map((agent) => agent.close()))
  }
})

test("sizing rejects overflowing capacity and memory arithmetic before provisioning", () => {
  assert.throws(() => make({ maxVms: Number.MAX_SAFE_INTEGER, agentsPerVm: 2 }), /maxVms/)
  assert.throws(() => make({ memoryMib: Number.MAX_SAFE_INTEGER }), /memoryMib/)
  assert.throws(() => make({ agentsPerVm: 2, memoryPerAgentMib: Number.MAX_SAFE_INTEGER }), /memoryMib/)
  assert.throws(() => make({ memoryBaseMib: Number.MAX_SAFE_INTEGER }), /memoryMib/)
  const maxSafeMib = Math.floor(Number.MAX_SAFE_INTEGER / 1024 ** 2)
  assert.equal(sizing({ memoryMib: maxSafeMib }).memoryMib, maxSafeMib)
  assert.throws(() => make({ memoryMib: maxSafeMib + 1 }), /memoryMib/)
})

test("durable jobs retain dedicated detached machines and reattach without refreshing or disk capacity", async () => {
  const fake = fakeSdk(() => ok)
  const first = makeJob({ sdk: fake.sdk, freeBytes: fakeFreeBytes, maxVms: 1 })
  const key = "execution-one#g0"
  const original = await held(first, key)
  await original.close()
  assert.equal(fake.destroyed.length, 0)
  assert.equal(fake.created[0]!.detached, true)
  assert.equal(fake.created[0]!.ephemeral, false)
  const labels = fake.created[0]!.labels as Record<string, string>
  assert.equal(labels["issue-sweep.job"], key)
  assert.equal(labels["smithers.execution"], "execution-one")
  assert.equal(fake.lines.filter((line) => line.includes(refreshLine)).length, 1)
  const restarted = makeJob({
    sdk: fake.sdk,
    freeBytes: () => {
      throw new Error("disk must not be read")
    },
    maxVms: 1
  })
  const attached = await held(restarted, key)
  assert.equal(attached.session.remoteId, original.session.remoteId)
  assert.equal(fake.created.length, 1)
  assert.equal(fake.lines.filter((line) => line.includes(refreshLine)).length, 1)
  await attached.close()
  await Effect.runPromise(restarted.destroy!(attached.session))
  assert.equal(fake.live.size, 0)
})

test("durable job capacity counts retained machines after restart and frees only on destruction", async () => {
  const fake = fakeSdk(() => ok)
  const options = { sdk: fake.sdk, freeBytes: fakeFreeBytes, maxVms: 1, refresh: false }
  const first = await held(makeJob(options), "old#g0")
  await first.close()
  const restarted = makeJob(options)
  const ready = await Effect.runPromise(Deferred.make<void>())
  const queued = Effect.runFork(Effect.scoped(Effect.gen(function*() {
    yield* restarted.acquire("new#g0")
    yield* Deferred.succeed(ready, undefined)
  })))
  try {
    await Effect.runPromise(Effect.sleep("30 millis"))
    assert.equal(await Effect.runPromise(Deferred.isDone(ready)), false)
    assert.equal(fake.created.length, 1)
    await Effect.runPromise(restarted.destroy!(first.session))
    await Effect.runPromise(Fiber.join(queued).pipe(Effect.timeout("2 seconds")))
    assert.equal(fake.created.length, 2)
    assert.equal(fake.live.size, 1)
  } finally {
    await Effect.runPromise(Fiber.interrupt(queued))
  }
})

test("retained jobs never pool and reject multiple agents per VM", async () => {
  assert.throws(() => makeJob({ agentsPerVm: 2 }), /agentsPerVm/)
  const fake = fakeSdk(() => ok)
  const provider = makeJob({ sdk: fake.sdk, freeBytes: fakeFreeBytes, maxVms: 2, refresh: false })
  const sessions = await Promise.all([held(provider, "a#g0"), held(provider, "b#g0")])
  assert.notEqual(sessions[0]!.session.remoteId, sessions[1]!.session.remoteId)
  await Promise.all(sessions.map((session) => session.close()))
  assert.equal(fake.live.size, 2)
  for (const session of sessions) await Effect.runPromise(provider.destroy!(session.session))
})

test("orphan reaping retains nonterminal and unknown executions and removes only terminal jobs", async () => {
  for (
    const status of ["running", "suspended", undefined, "completed", "failed", "cancelled", "lookup-error"] as const
  ) {
    const fake = fakeSdk(() => ok)
    const provider = makeJob({
      sdk: fake.sdk,
      freeBytes: fakeFreeBytes,
      refresh: false,
      holder: `${hostname()}:99999999`
    })
    const session = await held(provider, "reap-execution#g0")
    await session.close()
    const reaped = await Effect.runPromise(reapOrphans(fake.sdk, (execution) => {
      assert.equal(execution, "reap-execution")
      return status === "lookup-error" ? Effect.fail(new Error("unreachable")) : Effect.succeed(status)
    }))
    const terminal = status === "completed" || status === "failed" || status === "cancelled"
    assert.equal(reaped.length, terminal ? 1 : 0)
    assert.equal(fake.live.size, terminal ? 0 : 1)
  }
  const fake = fakeSdk(() => ok)
  const provider = makeJob({
    sdk: fake.sdk,
    freeBytes: fakeFreeBytes,
    refresh: false,
    holder: `${hostname()}:99999999`
  })
  await (await held(provider, "unknown-store#g0")).close()
  assert.deepEqual(await Effect.runPromise(reapOrphans(fake.sdk)), [])
})

test("failed initial job refresh removes the incomplete retained machine and releases agent capacity", async () => {
  let fail = true
  const fake = fakeSdk((line) => fail && line.includes(refreshLine) ? { code: 1, stderr: "refresh failed" } : ok)
  const provider = makeJob({ sdk: fake.sdk, freeBytes: fakeFreeBytes, maxVms: 1, maxAgents: 1 })
  const result = await Effect.runPromiseExit(Effect.scoped(provider.acquire("failed#g0")))
  assert.ok(Exit.isFailure(result))
  assert.match(Cause.pretty(result.cause), /refresh failed/)
  assert.equal(fake.live.size, 0)
  assert.equal(fake.destroyed.length, 1)
  fail = false
  const recovered = await held(provider, "failed#g0")
  assert.equal(fake.created.length, 2)
  await recovered.close()
  await Effect.runPromise(provider.destroy!(recovered.session))
})

test("durable capacity ignores ordinary issue machines and enforces disk only for a new job", async () => {
  const fake = fakeSdk(() => ok)
  const ordinary = await held(make({ sdk: fake.sdk, freeBytes: fakeFreeBytes, refresh: false }), "ordinary")
  let free = 0
  const provider = makeJob({ sdk: fake.sdk, freeBytes: () => free, minFreeBytes: 1, maxVms: 1, refresh: false })
  const ready = await Effect.runPromise(Deferred.make<void>())
  const queued = Effect.runFork(Effect.scoped(Effect.gen(function*() {
    yield* provider.acquire("disk#g0")
    yield* Deferred.succeed(ready, undefined)
  })))
  try {
    await Effect.runPromise(Effect.sleep("20 millis"))
    assert.equal(await Effect.runPromise(Deferred.isDone(ready)), false)
    assert.equal(fake.created.length, 1)
    free = 2
    await Effect.runPromise(Fiber.join(queued).pipe(Effect.timeout("2 seconds")))
    assert.equal(fake.created.length, 2, "ordinary machines do not spend retained job capacity")
    assert.equal(fake.live.size, 2)
  } finally {
    await Effect.runPromise(Fiber.interrupt(queued))
    await ordinary.close()
  }
})

test("new durable admission reaps dead ephemeral machines once while unknown durable executions survive", async () => {
  const fake = fakeSdk(() => ok)
  const deadHolder = `${hostname()}:99999999`
  const retained = await held(
    makeJob({ sdk: fake.sdk, freeBytes: fakeFreeBytes, refresh: false, holder: deadHolder }),
    "retained#g0"
  )
  const ordinary = await held(
    make({ sdk: fake.sdk, freeBytes: fakeFreeBytes, refresh: false, holder: deadHolder }),
    "dead-ordinary"
  )
  await retained.close()
  const restarted = makeJob({ sdk: fake.sdk, freeBytes: fakeFreeBytes, refresh: false, maxVms: 3 })
  const attached = await held(restarted, "retained#g0")
  assert.ok(fake.live.has(ordinary.session.remoteId), "existing-key acquisition bypasses startup reaping")
  await attached.close()
  const admitted = await held(restarted, "new#g0")
  assert.ok(fake.destroyed.includes(ordinary.session.remoteId))
  assert.ok(fake.live.has(retained.session.remoteId), "unknown execution is retained")
  const later = await held(
    make({ sdk: fake.sdk, freeBytes: fakeFreeBytes, refresh: false, holder: deadHolder }),
    "later-ordinary"
  )
  const next = await held(restarted, "next#g0")
  assert.ok(fake.live.has(later.session.remoteId), "startup reaping runs once per retained provider")
  await next.close()
  await admitted.close()
  await ordinary.close()
  await later.close()
  for (const session of [retained.session, admitted.session, next.session]) {
    await Effect.runPromise(restarted.destroy!(session))
  }
})

test("new durable admission uses ambient RunStore to reap terminal execution before counting capacity", async () => {
  const fake = fakeSdk(() => ok)
  const options = { sdk: fake.sdk, freeBytes: fakeFreeBytes, refresh: false, maxVms: 1 }
  const old = await held(makeJob({ ...options, holder: `${hostname()}:99999999` }), "terminal#g0")
  await old.close()
  const restarted = makeJob(options)
  const store = {
    get: (execution: string) => {
      assert.equal(execution, "terminal")
      return Effect.succeed({ status: "cancelled" })
    }
  } as unknown as RunStore.Service
  const newJob = await held({
    ...restarted,
    acquire: (key) => restarted.acquire(key).pipe(Effect.provideService(RunStore.RunStore, store))
  }, "replacement#g0")
  assert.ok(fake.destroyed.includes(old.session.remoteId))
  assert.equal(fake.live.size, 1)
  await newJob.close()
  await Effect.runPromise(restarted.destroy!(newJob.session))
})
