import { describe, expect, it } from "vitest"
import { normalizeArguments } from "../src/cli/Arguments.ts"
import * as Open from "../src/commands/Open.ts"

describe("repoFromRemote", () => {
  it("reads owner/repo from every remote spelling", () => {
    for (
      const remote of [
        "git@github.com:smithersai/smithers.git",
        "git@github.com:smithersai/smithers",
        "https://github.com/smithersai/smithers.git",
        "https://github.com/smithersai/smithers/",
        "https://user@smithers.sh/smithersai/smithers.git",
        "ssh://git@ssh.smithers.sh:2222/smithersai/smithers.git",
        "git://example.com/smithersai/smithers"
      ]
    ) expect({ remote, repo: Open.repoFromRemote(remote) }).toEqual({ remote, repo: "smithersai/smithers" })
  })

  it("refuses anything that is not exactly two segments", () => {
    for (
      const remote of [
        "",
        "not a remote",
        "https://gitlab.com/group/sub/repo.git",
        "https://github.com/solo",
        "file:///srv/git/owner/repo.git",
        "/srv/git/owner/repo.git",
        "https://github.com/../repo",
        "https://github.com/owner/repo?x=1",
        "git@github.com:/abs/path"
      ]
    ) expect({ remote, repo: Open.repoFromRemote(remote) }).toEqual({ remote, repo: null })
  })
})

describe("smthrs .", () => {
  it("is smthrs open .", () => {
    expect(normalizeArguments(["."])).toEqual(["open", "."])
    expect(normalizeArguments(["--json", "."])).toEqual(["open", ".", "--json"])
  })
})

interface Launch {
  readonly command: string
  readonly args: ReadonlyArray<string>
  readonly env?: Readonly<Record<string, string>> | undefined
}

const host = (options: {
  readonly platform?: NodeJS.Platform
  readonly remote?: string | null
  readonly files?: ReadonlyArray<string>
  readonly launchStatus?: number
}) => {
  const launches: Array<Launch> = []
  const files = new Set(["/work/checkout", ...(options.files ?? [])])
  const value: Open.Host = {
    platform: options.platform ?? "darwin",
    home: "/Users/me",
    exists: (path) => files.has(path),
    read: (command, args) => {
      const key = `${command} ${args.join(" ")}`
      if (key === "git remote get-url origin") {
        return options.remote === undefined
          ? "git@github.com:acme/widgets.git\n"
          : options.remote
      }
      if (key === "git rev-parse --show-toplevel") return "/work/checkout\n"
      return null
    },
    launch: async (command, args, launchOptions) => {
      launches.push({ command, args, env: launchOptions.env })
      return options.launchStatus ?? 0
    }
  }
  return { host: value, launches }
}

describe("open", () => {
  it("hands the installed app smithers://open/<owner>/<repo> by its path", async () => {
    const { host: h, launches } = host({ files: ["/Applications/Smithers.app"] })
    expect(await Open.open(h, "/work/checkout")).toEqual({
      repo: "acme/widgets",
      opened: "app",
      url: "smithers://open/acme/widgets"
    })
    expect(launches).toEqual([
      { command: "open", args: ["-a", "/Applications/Smithers.app", "smithers://open/acme/widgets"], env: undefined }
    ])
  })

  it("finds the app in ~/Applications too", async () => {
    const { host: h, launches } = host({ files: ["/Users/me/Applications/Smithers.app"] })
    expect((await Open.open(h, "/work/checkout")).opened).toBe("app")
    expect(launches[0]?.args[1]).toBe("/Users/me/Applications/Smithers.app")
  })

  it("prints the smithers.sh page when there is no app", async () => {
    const { host: h, launches } = host({})
    expect(await Open.open(h, "/work/checkout")).toEqual({
      repo: "acme/widgets",
      opened: "web",
      url: "https://smithers.sh/acme/widgets"
    })
    expect(launches).toEqual([])
  })

  it("never looks for the app off macOS", async () => {
    const { host: h, launches } = host({ platform: "linux", files: ["/Applications/Smithers.app"] })
    expect((await Open.open(h, "/work/checkout")).opened).toBe("web")
    expect(launches).toEqual([])
  })

  it("runs the dev build inside the smithers checkout, handed the same link", async () => {
    const { host: h, launches } = host({
      remote: "https://github.com/smithersai/smithers.git",
      files: ["/work/checkout/apps/app/electrobun.config.ts"]
    })
    expect(await Open.open(h, "/work/checkout")).toEqual({
      repo: "smithersai/smithers",
      opened: "dev",
      url: "smithers://open/smithersai/smithers"
    })
    expect(launches).toEqual([{
      command: "pnpm",
      args: ["--dir", "/work/checkout/apps/app", "dev"],
      env: { SMITHERS_OPEN_URL: "smithers://open/smithersai/smithers" }
    }])
  })

  it("never runs another checkout's scripts, even one shaped like smithers", async () => {
    const { host: h, launches } = host({ files: ["/work/checkout/apps/app/electrobun.config.ts"] })
    expect((await Open.open(h, "/work/checkout")).opened).toBe("web")
    expect(launches).toEqual([])
  })

  it("never runs the dev build for smithersai/smithers on a foreign host", async () => {
    for (
      const remote of [
        "https://evil.example/smithersai/smithers.git",
        "git@evil.example:smithersai/smithers.git",
        "https://github.com@evil.example/smithersai/smithers.git"
      ]
    ) {
      const { host: h, launches } = host({ remote, files: ["/work/checkout/apps/app/electrobun.config.ts"] })
      expect(await Open.open(h, "/work/checkout")).toEqual({
        repo: "smithersai/smithers",
        opened: "web",
        url: "https://smithers.sh/smithersai/smithers"
      })
      expect(launches).toEqual([])
    }
  })

  it("prefers the installed app inside the smithers checkout", async () => {
    const { host: h, launches } = host({
      remote: "git@github.com:smithersai/smithers.git",
      files: ["/Applications/Smithers.app", "/work/checkout/apps/app/electrobun.config.ts"]
    })
    expect((await Open.open(h, "/work/checkout")).opened).toBe("app")
    expect(launches.map((launch) => launch.command)).toEqual(["open"])
  })

  it("falls through when LaunchServices refuses", async () => {
    const { host: h } = host({ files: ["/Applications/Smithers.app"], launchStatus: 1 })
    expect((await Open.open(h, "/work/checkout")).opened).toBe("web")
  })

  it("reports a dev build that fails", async () => {
    const { host: h } = host({
      remote: "https://github.com/smithersai/smithers.git",
      files: ["/work/checkout/apps/app/electrobun.config.ts"],
      launchStatus: 7
    })
    await expect(Open.open(h, "/work/checkout")).rejects.toMatchObject({ message: expect.stringContaining("status 7") })
  })

  it("refuses a checkout without a usable remote", async () => {
    await expect(Open.open(host({ remote: null }).host, "/work/checkout")).rejects.toMatchObject({
      message: expect.stringContaining("no git remote")
    })
    await expect(Open.open(host({ remote: "https://gitlab.com/a/b/c" }).host, "/work/checkout")).rejects.toMatchObject({
      message: expect.stringContaining("does not name owner/repo")
    })
  })
})

describe("remote discovery", () => {
  const reading = (answers: Readonly<Record<string, string | null>>): Open.Host => ({
    platform: "linux",
    home: "/home/me",
    exists: () => true,
    read: (command, args) => answers[`${command} ${args.join(" ")}`] ?? null,
    launch: async () => 0
  })

  it("uses origin from the listing, then the first remote, then jj", () => {
    expect(Open.resolveRepo(
      reading({
        "git remote -v":
          "upstream\thttps://github.com/up/stream.git (fetch)\norigin\tgit@github.com:acme/widgets.git (fetch)\n"
      }),
      "/w"
    )).toBe("acme/widgets")
    expect(Open.resolveRepo(reading({ "git remote -v": "upstream\thttps://github.com/up/stream.git (fetch)\n" }), "/w"))
      .toBe("up/stream")
    expect(
      Open.resolveRepo(
        reading({ "git remote -v": "", "jj git remote list": "origin https://github.com/j/j.git\n" }),
        "/w"
      )
    )
      .toBe("j/j")
  })
})

describe("processHost", () => {
  const real = Open.processHost(process.env)

  it("reads a command's stdout, or null when it fails", () => {
    expect(real.read(process.execPath, ["-e", "process.stdout.write('ok')"], process.cwd())).toBe("ok")
    expect(real.read(process.execPath, ["-e", "process.exit(2)"], process.cwd())).toBeNull()
  })

  it("launches with the terminal inherited and answers the exit status", async () => {
    expect(
      await real.launch(process.execPath, ["-e", "process.exit(process.env.OPEN_TEST === 'x' ? 3 : 4)"], {
        cwd: process.cwd(),
        env: { OPEN_TEST: "x" }
      })
    ).toBe(3)
    await expect(real.launch("/nonexistent/smithers-open-test", [], { cwd: process.cwd() })).rejects.toThrow()
  })

  it("refuses a directory that does not exist", async () => {
    await expect(Open.open(real, "/nonexistent/smithers-open-test")).rejects.toMatchObject({
      message: expect.stringContaining("does not exist")
    })
  })
})
