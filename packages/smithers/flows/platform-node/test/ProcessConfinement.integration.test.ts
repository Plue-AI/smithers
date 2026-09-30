/** Real native mechanisms: no fake host, process runner, filesystem, or network. */
import * as NodeChildProcessSpawner from "@effect/platform-node/NodeChildProcessSpawner"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodeEffectPath from "@effect/platform-node/NodePath"
import type { Profile } from "@smthrs/kernel/ProcessConfinement"
import { Effect, Layer, Stream } from "effect"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import * as NodeChildProcess from "node:child_process"
import * as NodeFs from "node:fs"
import * as NodeHttp from "node:http"
import * as NodeNet from "node:net"
import * as NodeOs from "node:os"
import * as NodePath from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import * as ProcessConfinement from "../src/ProcessConfinement.ts"
import * as ProcessSandbox from "../src/ProcessSandbox.ts"

const spawnerLayer = NodeChildProcessSpawner.layer.pipe(
  Layer.provide(Layer.mergeAll(NodeFileSystem.layer, NodeEffectPath.layer))
)
const spawn = (command: ChildProcess.StandardCommand) =>
  Effect.gen(function*() {
    const spawner = yield* ChildProcessSpawner
    const handle = yield* spawner.spawn(command)
    const [code, stdout, stderr] = yield* Effect.all([
      handle.exitCode,
      handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
      handle.stderr.pipe(Stream.decodeText(), Stream.mkString)
    ], { concurrency: "unbounded" })
    return { code: Number(code), stdout, stderr }
  })

const native = ProcessSandbox.select({ network: "none" }, ProcessSandbox.host())
const available = !ProcessSandbox.isUnenforceable(native)
const fixtures: Array<string> = []
const fixture = () => {
  const parent = process.env.SMITHERS_TEST_SCRATCH ?? NodeOs.tmpdir()
  NodeFs.mkdirSync(parent, { recursive: true })
  const base = NodeFs.realpathSync(NodeFs.mkdtempSync(NodePath.join(parent, "confinement-real-")))
  fixtures.push(base)
  const workspaceRoot = NodePath.join(base, "workspace")
  const temporaryDirectory = NodePath.join(base, "temporary")
  NodeFs.mkdirSync(workspaceRoot)
  NodeFs.mkdirSync(temporaryDirectory)
  const profile: Profile = { workspaceRoot, reads: [], writes: [], readOnly: [], network: "none" }
  const service = ProcessConfinement.make({ temporaryDirectory })
  const execute = (command: ChildProcess.StandardCommand, overrides: Partial<Profile> = {}) =>
    Effect.runPromise(
      Effect.scoped(Effect.gen(function*() {
        const wrapped = yield* service.confine(command, { ...profile, ...overrides })
        return yield* spawn(wrapped)
      })).pipe(Effect.provide(spawnerLayer), Effect.timeout("10 seconds"))
    )
  return { workspaceRoot, temporaryDirectory, execute }
}
afterEach(() => {
  vi.unstubAllEnvs()
  for (const base of fixtures.splice(0)) NodeFs.rmSync(base, { recursive: true, force: true })
})

describe.skipIf(!available)("native ProcessConfinement enforcement", () => {
  it.skipIf(process.platform !== "linux")(
    "denies datagram and raw socketpair access to host abstract Unix endpoints",
    async () => {
      const f = fixture()
      NodeFs.mkdirSync(NodePath.join(f.workspaceRoot, "out"))
      const executable = NodePath.join(f.workspaceRoot, "out/datagram-probe")
      const source = String.raw`
#include <errno.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <poll.h>
#include <unistd.h>
int main(int argc, char **argv) {
  setvbuf(stdout, NULL, _IONBF, 0);
  if (argc < 3) return 90;
  struct sockaddr_un address = {.sun_family=AF_UNIX};
  size_t n = strlen(argv[2]);
  if (n >= sizeof(address.sun_path)-1) return 91;
  memcpy(address.sun_path+1, argv[2], n);
  socklen_t length = offsetof(struct sockaddr_un, sun_path)+1+n;
  if (!strcmp(argv[1], "server")) {
    int fd = socket(AF_UNIX, SOCK_DGRAM, 0);
    if (fd < 0 || bind(fd, (struct sockaddr *)&address, length)) return 92;
    puts("ready");
    struct pollfd pending[2] = {{.fd=fd,.events=POLLIN},{.fd=0,.events=POLLIN}};
    while (poll(pending, 2, 5000) > 0) {
      if (pending[1].revents) break;
      if (pending[0].revents & POLLIN) {
        char message[32];
        if (recv(fd, message, sizeof(message), 0) > 0) puts("received");
      }
    }
    close(fd); return 0;
  }
  int pair[2];
  int type = !strcmp(argv[1], "stream") ? SOCK_STREAM : !strcmp(argv[1], "raw") ? SOCK_RAW : SOCK_DGRAM;
  type |= SOCK_CLOEXEC | SOCK_NONBLOCK;
  if (socketpair(AF_UNIX, type, 0, pair)) { printf("pair:%d\n", errno); return 3; }
  if ((type & 0xf) == SOCK_STREAM) { puts("stream-ok"); close(pair[0]); close(pair[1]); return 0; }
  if (sendto(pair[0], "probe", 5, 0, (struct sockaddr *)&address, length) != 5) return 4;
  puts("sent"); close(pair[0]); close(pair[1]); return 0;
}
`
      const compiled = NodeChildProcess.spawnSync("cc", ["-x", "c", "-", "-o", executable], {
        input: source,
        encoding: "utf8"
      })
      expect(compiled.status, compiled.stderr).toBe(0)
      const address = `smithers-${process.pid}-${NodePath.basename(f.workspaceRoot)}-${Date.now()}`
      const server = NodeChildProcess.spawn(executable, ["server", address], { stdio: ["pipe", "pipe", "pipe"] })
      let output = ""
      server.stdout.on("data", (data: Buffer) => {
        output += data.toString()
      })
      const waitFor = async (text: string) => {
        for (let attempt = 0; attempt < 200; attempt++) {
          if (output.includes(text)) return
          if (server.exitCode !== null) throw new Error(`probe server exited ${server.exitCode}`)
          await new Promise<void>((resolve) => setTimeout(resolve, 5))
        }
        throw new Error(`probe server did not report ${text}`)
      }
      try {
        await waitFor("ready")
        for (const mode of ["client", "raw"] as const) {
          const command = ChildProcess.make(executable, [mode, address], { cwd: f.workspaceRoot })
          const raw = await Effect.runPromise(Effect.scoped(spawn(command)).pipe(Effect.provide(spawnerLayer)))
          expect(raw.code, raw.stderr).toBe(0)
          expect(raw.stdout).toBe("sent\n")
          await waitFor(mode === "client" ? "received" : "received\nreceived")
          for (const network of ["none", "open"] as const) {
            const denied = await f.execute(command, { reads: ["out"], network })
            expect(denied.code, denied.stderr).toBe(3)
            expect(denied.stdout).toBe("pair:1\n")
          }
        }
        for (const network of ["none", "open"] as const) {
          const stream = await f.execute(ChildProcess.make(executable, ["stream", address], { cwd: f.workspaceRoot }), {
            reads: ["out"],
            network
          })
          expect(stream.code, stream.stderr).toBe(0)
          expect(stream.stdout).toBe("stream-ok\n")
        }
        expect(output.match(/received/g)).toHaveLength(2)
      } finally {
        const exited = new Promise<void>((resolve) => server.once("exit", () => resolve()))
        server.stdin.end()
        if (server.exitCode === null) await exited
      }
    }
  )

  it.each(
    [
      ["absent env", undefined, undefined],
      ["absent env with extendEnv false", undefined, false],
      ["replacement env with omitted extendEnv", { CALLER: "named value" }, undefined],
      ["replacement env with extendEnv true", { CALLER: "named value" }, true],
      ["replacement env with extendEnv false", { CALLER: "named value" }, false]
    ] as const
  )("preserves the real Node spawner environment contract for %s", async (_, env, extendEnv) => {
    const f = fixture()
    vi.stubEnv("SMITHERS_HOST_SECRET", "inherited private fixture")
    const command = ChildProcess.make("/bin/sh", [
      "-c",
      "printf '%s|%s' \"${SMITHERS_HOST_SECRET-absent}\" \"${CALLER-absent}\""
    ], {
      cwd: f.workspaceRoot,
      env,
      extendEnv
    })
    const baseline = await Effect.runPromise(Effect.scoped(spawn(command)).pipe(Effect.provide(spawnerLayer)))
    expect(baseline.code, baseline.stderr).toBe(0)
    const result = await f.execute(command)
    expect(result.code, result.stderr).toBe(0)
    expect(result.stdout).toBe(baseline.stdout)
  })

  it("keeps credentials read- and write-closed when the workspace contains the host home", async () => {
    const f = fixture()
    const home = NodePath.join(f.workspaceRoot, "host-home")
    NodeFs.mkdirSync(NodePath.join(home, ".ssh"), { recursive: true })
    const key = NodePath.join(home, ".ssh/key")
    NodeFs.writeFileSync(key, "synthetic credential")
    vi.stubEnv("HOME", home)
    expect(ProcessSandbox.host().home).toBe(home)
    const service = ProcessConfinement.make({ temporaryDirectory: f.temporaryDirectory })
    const execute = (args: ReadonlyArray<string>) =>
      Effect.runPromise(
        Effect.scoped(Effect.gen(function*() {
          const wrapped = yield* service.confine(ChildProcess.make("/bin/sh", args, { cwd: f.workspaceRoot }), {
            workspaceRoot: f.workspaceRoot,
            reads: ["."],
            writes: ["."],
            readOnly: [],
            network: "none"
          })
          return yield* spawn(wrapped)
        })).pipe(Effect.provide(spawnerLayer), Effect.timeout("10 seconds"))
      )
    const read = await execute(["-c", "cat host-home/.ssh/key"])
    expect(read.code).not.toBe(0)
    expect(read.stdout).not.toContain("synthetic credential")
    const write = await execute(["-c", "printf changed > host-home/.ssh/key"])
    expect(write.code).not.toBe(0)
    expect(NodeFs.readFileSync(key, "utf8")).toBe("synthetic credential")
    const ordinary = await execute(["-c", "printf ordinary > host-home/ordinary.txt"])
    expect(ordinary.code, ordinary.stderr).toBe(0)
    expect(NodeFs.readFileSync(NodePath.join(home, "ordinary.txt"), "utf8")).toBe("ordinary")
  })

  it("starts with the default OS temporary directory without a TMPDIR override", async () => {
    const f = fixture()
    vi.stubEnv("TMPDIR", undefined)
    const temporaryRoot = NodeFs.realpathSync(NodeOs.tmpdir())
    const result = await Effect.runPromise(
      Effect.scoped(Effect.gen(function*() {
        const wrapped = yield* ProcessConfinement.make().confine(
          ChildProcess.make("/bin/echo", ["default temporary directory"], { cwd: f.workspaceRoot }),
          { workspaceRoot: f.workspaceRoot, reads: [], writes: [], readOnly: [], network: "none" }
        )
        const privateTmp = wrapped.options.env?.["TMPDIR"]!
        expect(NodeFs.realpathSync(privateTmp)).toBe(privateTmp)
        if (process.platform === "darwin") expect(privateTmp.startsWith(temporaryRoot + NodePath.sep)).toBe(true)
        return yield* spawn(wrapped)
      })).pipe(Effect.provide(spawnerLayer), Effect.timeout("10 seconds"))
    )
    expect(result.code, result.stderr).toBe(0)
    expect(result.stdout).toBe("default temporary directory\n")
  })

  it("starts through an aliased temporary parent with only canonical temporary grants", async () => {
    const f = fixture()
    const alias = NodePath.join(NodePath.dirname(f.workspaceRoot), "tmp-alias")
    NodeFs.symlinkSync(f.temporaryDirectory, alias, "dir")
    const result = await Effect.runPromise(
      Effect.scoped(Effect.gen(function*() {
        const wrapped = yield* ProcessConfinement.make({ temporaryDirectory: alias }).confine(
          ChildProcess.make("/bin/echo", ["alias temporary directory"], { cwd: f.workspaceRoot }),
          { workspaceRoot: f.workspaceRoot, reads: [], writes: [], readOnly: [], network: "none" }
        )
        if (process.platform === "darwin") expect(wrapped.args[1]).not.toContain(alias)
        return yield* spawn(wrapped)
      })).pipe(Effect.provide(spawnerLayer), Effect.timeout("10 seconds"))
    )
    expect(result.code, result.stderr).toBe(0)
    expect(result.stdout).toBe("alias temporary directory\n")
    expect(NodeFs.readdirSync(f.temporaryDirectory)).toEqual([])
  })

  it("starts when the inherited environment contains an exported Bash function", async () => {
    const f = fixture()
    vi.stubEnv("BASH_FUNC_which%%", "() { printf inherited; }")
    const result = await f.execute(ChildProcess.make("/bin/echo", ["started"], { cwd: f.workspaceRoot }))
    expect(result.code, result.stderr).toBe(0)
    expect(result.stdout).toBe("started\n")
  })

  it("refuses a read alias to an undeclared directory inside the workspace", async () => {
    const f = fixture()
    const secret = NodePath.join(f.workspaceRoot, "secret")
    NodeFs.mkdirSync(secret)
    NodeFs.writeFileSync(NodePath.join(secret, "private.txt"), "synthetic secret")
    NodeFs.symlinkSync(secret, NodePath.join(f.workspaceRoot, "alias"), "dir")
    await expect(f.execute(ChildProcess.make("/bin/cat", ["alias/private.txt"], { cwd: f.workspaceRoot }), {
      reads: ["alias"]
    })).rejects.toMatchObject({ reason: { _tag: "PermissionDenied", description: "read grant is a symbolic link" } })
    const allowed = await f.execute(ChildProcess.make("/bin/cat", ["secret/private.txt"], { cwd: f.workspaceRoot }), {
      reads: ["secret"]
    })
    expect(allowed.code, allowed.stderr).toBe(0)
    expect(allowed.stdout).toBe("synthetic secret")
  })

  it.skipIf(process.platform !== "darwin")(
    "denies undeclared stat and directory listings while retaining required cwd metadata",
    async () => {
      const f = fixture()
      NodeFs.writeFileSync(NodePath.join(f.workspaceRoot, "private.txt"), "synthetic metadata")
      const command = ChildProcess.make("/usr/bin/stat", ["-f", "%z", "private.txt"], { cwd: f.workspaceRoot })
      const denied = await f.execute(command)
      expect(denied.code).not.toBe(0)
      expect(denied.stdout).toBe("")
      const allowed = await f.execute(command, { reads: ["private.txt"] })
      expect(allowed.code, allowed.stderr).toBe(0)
      expect(allowed.stdout).toBe("18\n")
      const cwd = await f.execute(ChildProcess.make("/usr/bin/stat", ["-f", "%HT", "."], { cwd: f.workspaceRoot }))
      expect(cwd.code, cwd.stderr).toBe(0)
      expect(cwd.stdout).toBe("Directory\n")
      const listing = await f.execute(ChildProcess.make("/bin/ls", ["-A", "."], { cwd: f.workspaceRoot }))
      expect(listing.code).not.toBe(0)
      expect(listing.stdout).not.toContain("private.txt")
    }
  )

  it("permits a declared write tree and denies sibling writes including shell redirection", async () => {
    const f = fixture()
    const granted = await f.execute(
      ChildProcess.make("printf", ["allowed", ">", "out/result.txt"], {
        cwd: f.workspaceRoot,
        shell: true
      }),
      { writes: ["out"] }
    )
    expect(granted.code, granted.stderr).toBe(0)
    expect(NodeFs.readFileSync(NodePath.join(f.workspaceRoot, "out/result.txt"), "utf8")).toBe("allowed")
    const denied = await f.execute(
      ChildProcess.make("printf", ["forbidden", ">", "sibling.txt"], {
        cwd: f.workspaceRoot,
        shell: true
      }),
      { writes: ["out"] }
    )
    expect(denied.code).not.toBe(0)
    expect(NodeFs.existsSync(NodePath.join(f.workspaceRoot, "sibling.txt"))).toBe(false)
    expect(NodeFs.readdirSync(f.temporaryDirectory)).toEqual([])
  })

  it("permits declared reads and keeps undeclared workspace files unreadable", async () => {
    const f = fixture()
    NodeFs.writeFileSync(NodePath.join(f.workspaceRoot, "allowed.txt"), "public fixture")
    NodeFs.writeFileSync(NodePath.join(f.workspaceRoot, "private.txt"), "synthetic secret")
    const allowed = await f.execute(ChildProcess.make("/bin/cat", ["allowed.txt"], { cwd: f.workspaceRoot }), {
      reads: ["allowed.txt"]
    })
    expect(allowed.code, allowed.stderr).toBe(0)
    expect(allowed.stdout).toBe("public fixture")
    const denied = await f.execute(ChildProcess.make("/bin/cat", ["private.txt"], { cwd: f.workspaceRoot }), {
      reads: ["allowed.txt"]
    })
    expect(denied.code).not.toBe(0)
    expect(denied.stdout).not.toContain("synthetic secret")
  })

  it("re-closes a read-only tree inside a writable workspace", async () => {
    const f = fixture()
    NodeFs.mkdirSync(NodePath.join(f.workspaceRoot, "locked"))
    NodeFs.writeFileSync(NodePath.join(f.workspaceRoot, "locked/original.txt"), "original")
    const denied = await f.execute(
      ChildProcess.make("printf", ["changed", ">", "locked/original.txt"], {
        cwd: f.workspaceRoot,
        shell: true
      }),
      { reads: ["."], writes: ["."], readOnly: ["locked"] }
    )
    expect(denied.code).not.toBe(0)
    expect(NodeFs.readFileSync(NodePath.join(f.workspaceRoot, "locked/original.txt"), "utf8")).toBe("original")
    const allowed = await f.execute(
      ChildProcess.make("printf", ["allowed", ">", "sibling.txt"], {
        cwd: f.workspaceRoot,
        shell: true
      }),
      { reads: ["."], writes: ["."], readOnly: ["locked"] }
    )
    expect(allowed.code, allowed.stderr).toBe(0)
    expect(NodeFs.readFileSync(NodePath.join(f.workspaceRoot, "sibling.txt"), "utf8")).toBe("allowed")
  })

  it("executes in the canonical workspace when its root and cwd are aliases", async () => {
    const f = fixture()
    const alias = NodePath.join(NodePath.dirname(f.workspaceRoot), "alias")
    NodeFs.symlinkSync(f.workspaceRoot, alias, "dir")
    const result = await f.execute(
      ChildProcess.make("printf", ["canonical", ">", "out/result.txt"], {
        cwd: alias,
        shell: true
      }),
      { workspaceRoot: alias, writes: ["out"] }
    )
    expect(result.code, result.stderr).toBe(0)
    expect(NodeFs.readFileSync(NodePath.join(f.workspaceRoot, "out/result.txt"), "utf8")).toBe("canonical")
  })

  it("refuses symlinked reads of host bytes before a process can run", async () => {
    const f = fixture()
    const outside = NodePath.join(NodePath.dirname(f.workspaceRoot), "private")
    NodeFs.mkdirSync(outside)
    NodeFs.writeFileSync(NodePath.join(outside, "fixture.txt"), "synthetic host secret")
    NodeFs.symlinkSync(outside, NodePath.join(f.workspaceRoot, "docs"), "dir")
    await expect(
      f.execute(ChildProcess.make("/bin/cat", ["docs/fixture.txt"], { cwd: f.workspaceRoot }), { reads: ["docs"] })
    ).rejects.toMatchObject({
      reason: { _tag: "PermissionDenied", description: expect.stringContaining("read grant resolves outside") }
    })
    expect(NodeFs.readdirSync(f.temporaryDirectory)).toEqual([])
  })

  it.skipIf(process.platform !== "darwin")("denies launchd delegation without starting an application", async () => {
    const f = fixture()
    const command = ChildProcess.make("/bin/launchctl", ["print", `user/${process.getuid!()}`], {
      cwd: f.workspaceRoot
    })
    const baseline = await Effect.runPromise(Effect.scoped(spawn(command)).pipe(Effect.provide(spawnerLayer)))
    expect(baseline.code, baseline.stderr).toBe(0)
    const label = `smithers-confinement.${NodePath.basename(NodePath.dirname(f.workspaceRoot))}`
    const submit = ChildProcess.make("/bin/launchctl", [
      "submit",
      "-l",
      label,
      "--",
      NodePath.join(f.workspaceRoot, "nonexistent-executable")
    ], { cwd: f.workspaceRoot })
    try {
      const denied = await f.execute(submit)
      expect(denied.code).not.toBe(0)
    } finally {
      await Effect.runPromise(
        Effect.scoped(spawn(ChildProcess.make("/bin/launchctl", ["remove", label]))).pipe(Effect.provide(spawnerLayer))
      )
    }
  })

  it("restores target environment values without shell expansion or exposing them on wrapper argv", async () => {
    const f = fixture()
    const marker = NodePath.join(f.workspaceRoot, "injected.txt")
    const value = `quote'\n$(touch ${marker})\`touch ${marker}\``
    const result = await f.execute(ChildProcess.make("/bin/sh", ["-c", "printf \"%s\" \"$KEEP\""], {
      cwd: f.workspaceRoot,
      env: { KEEP: value, LD_LIBRARY_PATH: "/synthetic/libs" },
      extendEnv: false
    }))
    expect(result.code, result.stderr).toBe(0)
    expect(result.stdout).toBe(value)
    expect(NodeFs.existsSync(marker)).toBe(false)
  })

  it("denies host Unix sockets even with open IP networking", async () => {
    const parent = process.env.SMITHERS_TEST_SCRATCH ?? NodeOs.tmpdir()
    const workspaceRoot = NodeFs.realpathSync(NodeFs.mkdtempSync(NodePath.join(parent, "u")))
    fixtures.push(workspaceRoot)
    const socket = NodePath.join(workspaceRoot, "s")
    let connections = 0
    const server = NodeNet.createServer((connection) => {
      connections++
      connection.end("unix fixture")
    })
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(socket, resolve)
    })
    const service = ProcessConfinement.make({ temporaryDirectory: workspaceRoot })
    const profile: Profile = { workspaceRoot, reads: ["."], writes: [], readOnly: [], network: "none" }
    const command = ChildProcess.make(process.execPath, [
      "-e",
      [
        "const net=require('node:net')",
        `const socket=net.createConnection(${JSON.stringify(socket)})`,
        "socket.on('data',data=>process.stdout.write(data))",
        "socket.on('error',()=>process.exit(2))"
      ].join(";")
    ], { cwd: workspaceRoot })
    const execute = (network: Profile["network"]) =>
      Effect.runPromise(
        Effect.scoped(Effect.gen(function*() {
          const wrapped = yield* service.confine(command, { ...profile, network })
          return yield* spawn(wrapped)
        })).pipe(Effect.provide(spawnerLayer), Effect.timeout("10 seconds"))
      )
    try {
      const baseline = await Effect.runPromise(Effect.scoped(spawn(command)).pipe(Effect.provide(spawnerLayer)))
      expect(baseline.code, baseline.stderr).toBe(0)
      expect(baseline.stdout).toBe("unix fixture")
      expect(connections).toBe(1)
      const denied = await execute("none")
      expect(denied.code).not.toBe(0)
      expect(connections).toBe(1)
      const open = await execute("open")
      expect(open.code).not.toBe(0)
      expect(connections).toBe(1)
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    }
  })

  it.skipIf(ProcessSandbox.host().executable("curl") === undefined)(
    "denies localhost TCP until the network is explicitly opened",
    async () => {
      const f = fixture()
      let requests = 0
      const server = NodeHttp.createServer((_, response) => {
        requests++
        response.end("network fixture")
      })
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
      try {
        const address = server.address()
        if (address === null || typeof address === "string") throw new Error("missing server address")
        const command = ChildProcess.make(ProcessSandbox.host().executable("curl")!, [
          "--noproxy",
          "*",
          "--max-time",
          "2",
          "--silent",
          "--show-error",
          `http://127.0.0.1:${address.port}`
        ], { cwd: f.workspaceRoot })
        const denied = await f.execute(command)
        expect(denied.code).not.toBe(0)
        expect(requests).toBe(0)
        const allowed = await f.execute(command, { network: "open" })
        expect(allowed.code, allowed.stderr).toBe(0)
        expect(allowed.stdout).toBe("network fixture")
        expect(requests).toBe(1)
        const hostname = await f.execute(
          ChildProcess.make(ProcessSandbox.host().executable("curl")!, [
            "--noproxy",
            "*",
            "--max-time",
            "2",
            "--silent",
            "--show-error",
            `http://localhost:${address.port}`
          ], { cwd: f.workspaceRoot }),
          { network: "open" }
        )
        expect(hostname.code, hostname.stderr).toBe(0)
        expect(hostname.stdout).toBe("network fixture")
        expect(requests).toBe(2)
      } finally {
        await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
      }
    }
  )
})
