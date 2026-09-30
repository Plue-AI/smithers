import { AGENT_ROLES } from "@smthrs/rpc/AgentRoles"
import { HARNESS_IDS } from "@smthrs/rpc/LocalApp"
import { delimiter, join } from "node:path"
import { describe, expect, test } from "vitest"
import {
  decodeJwtClaims,
  detectHarnessesWith,
  DETECTORS,
  findBinary,
  harnessCandidateDirs,
  harnessModels,
  harnessModelSpec,
  modelProbeEnv,
  parseVersionLine,
  PROBE_ENV_KEYS,
  probeEnv,
  VERSION_TIMEOUT_MS
} from "../src/index.ts"
import type { HarnessHost } from "../src/index.ts"

/*
 * The detection table over a fake host: files, binaries and env are data,
 * so the sign-in signals and the candidate order hold on any machine.
 */

const HOME = "/Users/u"

interface Fake {
  readonly files?: Record<string, string>
  readonly binaries?: ReadonlyArray<string>
  readonly env?: Record<string, string | undefined>
  readonly versions?: Record<string, string | null>
  readonly platform?: string
  readonly home?: string
}

const jwt = (claims: Record<string, unknown>): string =>
  `eyJhbGciOiJSUzI1NiJ9.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`

const host = (fake: Fake = {}): HarnessHost & { readonly probed: Array<string> } => {
  const files = fake.files ?? {}
  const binaries = new Set(fake.binaries ?? [])
  const probed: Array<string> = []
  const separator = fake.platform === "win32" ? "\\" : "/"
  return {
    env: { PATH: "/usr/bin:/bin", ...fake.env },
    home: fake.home ?? HOME,
    platform: fake.platform ?? "darwin",
    listDir: (dir) => {
      const entries = new Set<string>()
      for (const path of [...Object.keys(files), ...binaries]) {
        if (path.startsWith(`${dir}${separator}`)) entries.add(path.slice(dir.length + 1).split(separator)[0] ?? "")
      }
      return [...entries]
    },
    isFile: (path) => path in files || binaries.has(path),
    readText: (path) => files[path] ?? null,
    version: async (binary) => {
      probed.push(binary)
      const versions = fake.versions ?? {}
      return binary in versions ? versions[binary] ?? null : "1.2.3"
    },
    probed
  }
}

describe("the candidate dirs", () => {
  test("callers without a platform keep the native path convention", () => {
    expect(harnessCandidateDirs({ home: HOME, listDir: () => [] })[0]).toBe(join(HOME, ".local", "bin"))
  })

  test("Windows host paths and PATH separators do not depend on the runner", () => {
    const h = host({
      platform: "win32",
      home: "C:\\Users\\u",
      env: { PATH: "D:\\first;D:\\second" },
      binaries: [
        "C:\\Users\\u\\.local\\bin\\claude.exe",
        "C:\\Users\\u\\.nvm\\versions\\node\\v24.1.0\\bin\\node.exe",
        "D:\\first\\claude.cmd",
        // The POSIX shim npm writes beside the .cmd is not a Windows command.
        "D:\\second\\codex",
        "D:\\second\\codex.cmd"
      ]
    })
    expect(harnessCandidateDirs(h)).toContain("C:\\Users\\u\\.nvm\\versions\\node\\v24.1.0\\bin")
    expect(harnessCandidateDirs(h)).not.toContain("/opt/homebrew/bin")
    expect(harnessCandidateDirs(h)).not.toContain("/usr/local/bin")
    expect(findBinary("claude", h)).toBe("C:\\Users\\u\\.local\\bin\\claude.exe")
    expect(findBinary("codex", h)).toBe("D:\\second\\codex.cmd")
    expect(findBinary("gemini", h)).toBeNull()
  })

  test("Windows honors a PathExt spelled in any case", () => {
    const h = host({
      platform: "win32",
      home: "C:\\Users\\u",
      env: { PATH: undefined, Path: "D:\\tools", PathExt: ".PS1" },
      binaries: ["D:\\tools\\codex.cmd", "D:\\tools\\codex.ps1"]
    })
    expect(findBinary("codex", h)).toBe("D:\\tools\\codex.ps1")
  })

  test("explicit dirs come before PATH, nvm highest first", () => {
    const h = host({
      binaries: [
        "/Users/u/.nvm/versions/node/v22.19.0/bin/node",
        "/Users/u/.nvm/versions/node/v24.1.0/bin/node"
      ]
    })
    expect(harnessCandidateDirs(h)).toEqual([
      "/Users/u/.local/bin",
      "/Users/u/.bun/bin",
      "/opt/homebrew/bin",
      "/usr/local/bin",
      "/Users/u/.nvm/versions/node/v24.1.0/bin",
      "/Users/u/.nvm/versions/node/v22.19.0/bin",
      "/Users/u/.cargo/bin",
      "/Users/u/.opencode/bin"
    ])
  })

  test("a node dir is ordered on every version field, and a non-version entry is not one", () => {
    const h = host({
      binaries: [
        "/Users/u/.nvm/versions/node/.DS_Store/x",
        "/Users/u/.nvm/versions/node/v22.19.0/bin/node",
        "/Users/u/.nvm/versions/node/v22.19.4/bin/node",
        "/Users/u/.nvm/versions/node/v22.20.0/bin/node",
        // The same version spelled without the `v`: equal on all three fields.
        "/Users/u/.nvm/versions/node/22.19.4/bin/node"
      ]
    })
    expect(harnessCandidateDirs(h).filter((dir) => dir.includes(".nvm"))).toEqual([
      "/Users/u/.nvm/versions/node/v22.20.0/bin",
      "/Users/u/.nvm/versions/node/v22.19.4/bin",
      "/Users/u/.nvm/versions/node/22.19.4/bin",
      "/Users/u/.nvm/versions/node/v22.19.0/bin"
    ])
  })

  test("findBinary prefers a candidate dir over PATH and falls back to PATH", () => {
    const h = host({ binaries: ["/Users/u/.local/bin/claude", "/usr/bin/claude", "/usr/bin/codex"] })
    expect(findBinary("claude", h)).toBe("/Users/u/.local/bin/claude")
    expect(findBinary("codex", h)).toBe("/usr/bin/codex")
    expect(findBinary("gemini", h)).toBeNull()
  })

  test("an unset PATH leaves the candidate dirs as the whole search", () => {
    const h = host({ binaries: ["/Users/u/.bun/bin/codex", "/usr/bin/claude"], env: { PATH: undefined } })
    expect(findBinary("codex", h)).toBe("/Users/u/.bun/bin/codex")
    expect(findBinary("claude", h)).toBeNull()
  })

  test("a relative PATH entry is never searched, so the cwd cannot plant a binary", async () => {
    // A cloned repository is the cwd: `.` and `node_modules/.bin` would resolve inside it.
    const h = host({
      binaries: ["node_modules/.bin/claude", "./codex", "codex", "/usr/bin/codex"],
      env: { PATH: ".:node_modules/.bin:/usr/bin" }
    })
    expect(findBinary("claude", h)).toBeNull()
    expect(findBinary("codex", h)).toBe("/usr/bin/codex")
    await detectHarnessesWith(h)
    expect(h.probed).toEqual(["/usr/bin/codex"])
    const windows = host({
      platform: "win32",
      home: "C:\\Users\\u",
      binaries: ["tools\\claude.exe", "\\rel\\codex.exe", "D:\\bin\\codex.exe"],
      env: { PATH: "tools;D:\\bin" }
    })
    expect(findBinary("claude", windows)).toBeNull()
    expect(findBinary("codex", windows)).toBe("D:\\bin\\codex.exe")
  })
})

describe("the table", () => {
  test("Windows host credentials and home labels use the supplied platform", async () => {
    const h = host({
      platform: "win32",
      home: "C:\\Users\\u",
      env: { PATH: "D:\\tools", CODEX_HOME: "D:\\config\\codex" },
      binaries: ["D:\\tools\\codex.cmd", "D:\\tools\\hermes.exe"],
      files: {
        "D:\\config\\codex\\auth.json": JSON.stringify({ tokens: { id_token: jwt({ email: "a@b.c" }) } }),
        "C:\\Users\\u\\.hermes\\auth.json": JSON.stringify({ providers: { local: "fixture" } })
      }
    })
    const rows = await detectHarnessesWith(h)
    expect(rows.find((row) => row.id === "codex")).toMatchObject({ status: "signed-in", account: { email: "a@b.c" } })
    expect(rows.find((row) => row.id === "hermes")).toMatchObject({
      status: "signed-in",
      account: { label: "~\\.hermes\\auth.json" }
    })
  })

  test("covers every contract id in order with an interactive launch", () => {
    expect(DETECTORS.map((detector) => detector.id)).toEqual([...HARNESS_IDS])
    for (const detector of DETECTORS) {
      expect(detector.launch[0]).toBe(detector.binary)
      expect(detector.launch).not.toContain("--dangerously-skip-permissions")
      expect(detector.launch).not.toContain("--yolo")
    }
  })

  test("an absent binary is unavailable even with credentials on disk", async () => {
    const h = host({ files: { "/Users/u/.claude.json": JSON.stringify({ oauthAccount: { emailAddress: "a@b.c" } }) } })
    const [claude] = await detectHarnessesWith(h)
    expect(claude).toEqual({
      id: "claude",
      displayName: "Claude Code",
      binary: null,
      version: null,
      status: "unavailable",
      account: null,
      launch: { argv: ["claude"] },
      models: { suggestions: ["claude-fable-5", "fable", "opus", "sonnet"], listable: false }
    })
    expect(h.probed).toEqual([])
  })

  test("the model table names the verified flag per harness and only a list command's harness is listable", async () => {
    // Each flag and suggestion is the installed binary's own --help text (custom-agents.md); a harness whose help names no model flag has no entry.
    expect(harnessModelSpec("claude")).toEqual({ binary: "claude", flag: ["--model"] })
    expect(harnessModelSpec("codex")).toEqual({ binary: "codex", flag: ["-m"] })
    expect(harnessModelSpec("gemini")).toEqual({ binary: "gemini", flag: ["--model"] })
    expect(harnessModelSpec("kimi")).toEqual({ binary: "kimi", flag: ["--model"] })
    expect(harnessModelSpec("opencode-kimi")).toEqual({ binary: "opencode", flag: ["--model"] })
    expect(harnessModelSpec("cursor-agent")).toEqual({ binary: "cursor-agent", flag: ["--model"] })
    expect(harnessModelSpec("hermes")).toEqual({ binary: "hermes", flag: ["--model"] })
    for (const id of ["crush", "amp", "pi"]) {
      expect(harnessModelSpec(id)).toBeUndefined()
      expect(harnessModels(id)).toBeUndefined()
    }
    expect(harnessModelSpec("nope")).toBeUndefined()
    expect(harnessModels("codex")).toEqual({
      flag: ["-m"],
      suggestions: ["gpt-6.1-sol", "gpt-6-sol", "gpt-6-luna"]
    })
    expect(harnessModels("opencode")?.list).toEqual(["opencode", "models"])
    expect(harnessModels("opencode-kimi")?.list).toEqual(["opencode", "models", "kimi-for-coding"])
    expect(harnessModels("opencode-cerebras")?.list).toEqual(["opencode", "models", "cerebras"])
    // Every built-in role's harness takes a model flag, and every suggestion is a model id.
    for (const role of AGENT_ROLES) expect(harnessModelSpec(role.harness)).toBeDefined()
    for (const detector of DETECTORS) {
      expect(detector.models?.list?.[0] ?? detector.binary).toBe(detector.binary)
      for (const model of detector.models?.suggestions ?? []) {
        expect(model).toMatch(/^[A-Za-z0-9][A-Za-z0-9._/:-]{0,80}$/)
      }
    }
    // The wire carries the suggestions and whether a list command exists, never the flag.
    const all = await detectHarnessesWith(host({ binaries: ["/Users/u/.opencode/bin/opencode"] }))
    const byId = Object.fromEntries(all.map((harness) => [harness.id, harness]))
    expect(byId.opencode?.models).toEqual({
      suggestions: ["kimi-for-coding/k3", "cerebras/qwen-3.8-27b"],
      listable: true
    })
    expect(byId.codex?.models).toEqual({
      suggestions: ["gpt-6.1-sol", "gpt-6-sol", "gpt-6-luna"],
      listable: false
    })
    expect(byId.crush?.models).toBeUndefined()
    expect(JSON.stringify(byId.opencode)).not.toContain("flag")
  })

  test("claude: oauthAccount email and organization, else .credentials.json, else ANTHROPIC_API_KEY", async () => {
    const claudeOf = async (fake: Fake) =>
      (await detectHarnessesWith(host({ binaries: ["/opt/homebrew/bin/claude"], ...fake })))[0]
    expect(
      await claudeOf({
        files: {
          "/Users/u/.claude.json": JSON.stringify({
            oauthAccount: { emailAddress: "will@codeplane.app", organizationName: "Org" }
          })
        }
      })
    ).toMatchObject({ status: "signed-in", account: { email: "will@codeplane.app", label: "Org" }, version: "1.2.3" })
    // An oauthAccount with neither field is still a sign-in, with nothing to label it.
    expect(await claudeOf({ files: { "/Users/u/.claude.json": JSON.stringify({ oauthAccount: {} }) } }))
      .toMatchObject({ status: "signed-in", account: {} })
    expect(await claudeOf({ files: { "/Users/u/.claude/.credentials.json": "{}" } })).toMatchObject({
      status: "signed-in",
      account: null
    })
    expect(await claudeOf({ env: { CLAUDE_CONFIG_DIR: "/cfg" }, files: { "/cfg/.credentials.json": "{}" } }))
      .toMatchObject({ status: "signed-in" })
    // A second account under CLAUDE_CONFIG_DIR keeps its .claude.json there,
    // and it wins over the default account's file in home.
    expect(
      await claudeOf({
        env: { CLAUDE_CONFIG_DIR: "/cfg" },
        files: {
          "/cfg/.claude.json": JSON.stringify({ oauthAccount: { emailAddress: "second@b.c" } }),
          "/Users/u/.claude.json": JSON.stringify({ oauthAccount: { emailAddress: "first@b.c" } })
        }
      })
    ).toMatchObject({ status: "signed-in", account: { email: "second@b.c" } })
    // An empty override is no override: the default config dir still answers.
    expect(await claudeOf({ env: { CLAUDE_CONFIG_DIR: "" }, files: { "/Users/u/.claude/.credentials.json": "{}" } }))
      .toMatchObject({ status: "signed-in" })
    // Unparseable and non-object state files read as no state at all.
    expect(await claudeOf({ files: { "/Users/u/.claude.json": "{ not json" } })).toMatchObject({
      status: "binary-only"
    })
    expect(await claudeOf({ files: { "/Users/u/.claude.json": "[]" } })).toMatchObject({ status: "binary-only" })
    expect(await claudeOf({ files: { "/Users/u/.claude.json": JSON.stringify({ oauthAccount: null }) } }))
      .toMatchObject({ status: "binary-only" })
    expect(await claudeOf({ env: { ANTHROPIC_API_KEY: "sk-x" } })).toMatchObject({
      status: "api-key",
      account: { label: "ANTHROPIC_API_KEY" }
    })
    expect(await claudeOf({})).toMatchObject({
      status: "binary-only",
      account: null,
      binary: "/opt/homebrew/bin/claude"
    })
  })

  test("codex: the id_token email claim, then the auth.json key, then OPENAI_API_KEY", async () => {
    const codexOf = async (fake: Fake) =>
      (await detectHarnessesWith(host({ binaries: ["/Users/u/.bun/bin/codex"], ...fake })))[1]
    expect(
      await codexOf({
        files: {
          "/Users/u/.codex/auth.json": JSON.stringify({ tokens: { id_token: jwt({ email: "will@codeplane.app" }) } })
        }
      })
    ).toMatchObject({ status: "signed-in", account: { email: "will@codeplane.app" } })
    expect(
      await codexOf({
        env: { CODEX_HOME: "/cx" },
        files: { "/cx/auth.json": JSON.stringify({ tokens: { access_token: "tok" } }) }
      })
    ).toMatchObject({ status: "signed-in", account: null })
    // A claimless id_token still proves a session.
    expect(
      await codexOf({ files: { "/Users/u/.codex/auth.json": JSON.stringify({ tokens: { id_token: "opaque" } }) } })
    )
      .toMatchObject({ status: "signed-in", account: null })
    // A tokens object with nothing in it is not a session.
    expect(await codexOf({ files: { "/Users/u/.codex/auth.json": JSON.stringify({ tokens: {} }) } }))
      .toMatchObject({ status: "binary-only" })
    expect(await codexOf({ files: { "/Users/u/.codex/auth.json": JSON.stringify({ tokens: null }) } }))
      .toMatchObject({ status: "binary-only" })
    expect(await codexOf({ files: { "/Users/u/.codex/auth.json": JSON.stringify({ OPENAI_API_KEY: "sk-1" }) } }))
      .toMatchObject({ status: "api-key" })
    expect(await codexOf({ env: { OPENAI_API_KEY: "sk-2" } })).toMatchObject({
      status: "api-key",
      account: { label: "OPENAI_API_KEY" }
    })
    expect(await codexOf({})).toMatchObject({ status: "binary-only" })
  })

  test("gemini, kimi, opencode, hermes, pi read their config files", async () => {
    const all = await detectHarnessesWith(host({
      binaries: [
        "/opt/homebrew/bin/gemini",
        "/Users/u/.local/bin/kimi",
        "/Users/u/.opencode/bin/opencode",
        "/Users/u/.local/bin/hermes",
        "/usr/local/bin/pi"
      ],
      files: {
        "/Users/u/.gemini/oauth_creds.json": "{}",
        "/Users/u/.gemini/google_accounts.json": JSON.stringify({ active: "me@gmail.com" }),
        "/Users/u/.kimi/credentials/kimi-code.json": "{}",
        "/Users/u/.local/share/opencode/auth.json": JSON.stringify({
          anthropic: { type: "oauth", access: "x" },
          openai: {}
        }),
        "/Users/u/.hermes/auth.json": JSON.stringify({ providers: { openai: "k" } }),
        "/Users/u/.pi/agent/auth.json": "[]"
      }
    }))
    const byId = Object.fromEntries(all.map((harness) => [harness.id, harness]))
    expect(byId.gemini).toMatchObject({ status: "signed-in", account: { email: "me@gmail.com" } })
    expect(byId.kimi).toMatchObject({ status: "signed-in", account: { label: "kimi-code" } })
    expect(byId.opencode).toMatchObject({ status: "signed-in", account: { label: "anthropic" } })
    // The same binary with no Kimi credential: installed, not launchable on Kimi.
    expect(byId["opencode-kimi"]).toMatchObject({
      status: "binary-only",
      binary: "/Users/u/.opencode/bin/opencode",
      launch: { argv: ["opencode", "--model", "kimi-for-coding/k3"] }
    })
    expect(byId.hermes).toMatchObject({ status: "signed-in", account: { label: "~/.hermes/auth.json" } })
    expect(byId.pi).toMatchObject({ status: "binary-only", binary: "/usr/local/bin/pi" })
  })

  test("gemini: oauth without a named account, then the API keys, then nothing", async () => {
    const geminiOf = async (fake: Fake) =>
      (await detectHarnessesWith(host({ binaries: ["/opt/homebrew/bin/gemini"], ...fake })))
        .find((harness) => harness.id === "gemini")
    expect(await geminiOf({ files: { "/Users/u/.gemini/oauth_creds.json": "{}" } }))
      .toMatchObject({ status: "signed-in", account: null })
    expect(await geminiOf({ env: { GEMINI_DIR: "/g" }, files: { "/g/oauth_creds.json": "{}" } }))
      .toMatchObject({ status: "signed-in" })
    expect(await geminiOf({ env: { GOOGLE_API_KEY: "k" } }))
      .toMatchObject({ status: "api-key", account: { label: "GOOGLE_API_KEY" } })
    expect(await geminiOf({})).toMatchObject({ status: "binary-only" })
  })

  test("kimi: the share dir may be overridden, and nothing else signs it in", async () => {
    const kimiOf = async (fake: Fake) =>
      (await detectHarnessesWith(host({ binaries: ["/Users/u/.local/bin/kimi"], ...fake })))
        .find((harness) => harness.id === "kimi")
    expect(await kimiOf({ env: { KIMI_SHARE_DIR: "/k" }, files: { "/k/credentials/kimi-code.json": "{}" } }))
      .toMatchObject({ status: "signed-in", account: { label: "kimi-code" } })
    expect(await kimiOf({ env: { KIMI_API_KEY: "sk" } })).toMatchObject({ status: "binary-only" })
  })

  test("opencode-kimi: the kimi-for-coding credential in auth.json, else KIMI_API_KEY", async () => {
    const withAuth = await detectHarnessesWith(host({
      binaries: ["/Users/u/.opencode/bin/opencode"],
      files: {
        "/Users/u/.local/share/opencode/auth.json": JSON.stringify({ "kimi-for-coding": { type: "api", key: "k" } })
      }
    }))
    expect(withAuth.find((harness) => harness.id === "opencode-kimi")).toMatchObject({
      status: "signed-in",
      account: { label: "kimi-for-coding" }
    })
    const withEnv = await detectHarnessesWith(host({
      binaries: ["/Users/u/.opencode/bin/opencode"],
      env: { KIMI_API_KEY: "sk-kimi" }
    }))
    const byId = Object.fromEntries(withEnv.map((harness) => [harness.id, harness]))
    expect(byId["opencode-kimi"]).toMatchObject({ status: "api-key", account: { label: "KIMI_API_KEY" } })
    // The plain OpenCode entry counts the Kimi key as a credential too.
    expect(byId.opencode).toMatchObject({ status: "api-key", account: { label: "KIMI_API_KEY" } })
  })

  test("opencode-cerebras (the fast-ui role): the cerebras credential in auth.json, else CEREBRAS_API_KEY", async () => {
    const withAuth = await detectHarnessesWith(host({
      binaries: ["/Users/u/.opencode/bin/opencode"],
      files: { "/Users/u/.local/share/opencode/auth.json": JSON.stringify({ cerebras: { type: "api", key: "c" } }) }
    }))
    expect(withAuth.find((harness) => harness.id === "opencode-cerebras")).toMatchObject({
      status: "signed-in",
      account: { label: "cerebras" },
      launch: { argv: ["opencode", "--model", "cerebras/qwen-3.8-27b"] }
    })
    const withEnv = await detectHarnessesWith(host({
      binaries: ["/Users/u/.opencode/bin/opencode"],
      env: { CEREBRAS_API_KEY: "csk" }
    }))
    expect(withEnv.find((harness) => harness.id === "opencode-cerebras")).toMatchObject({
      status: "api-key",
      account: { label: "CEREBRAS_API_KEY" }
    })
    const bare = await detectHarnessesWith(host({ binaries: ["/Users/u/.opencode/bin/opencode"] }))
    expect(bare.find((harness) => harness.id === "opencode-cerebras")).toMatchObject({ status: "binary-only" })
  })

  test("crush: an env key wins, then either config file, else binary-only", async () => {
    const crushOf = async (fake: Fake) =>
      (await detectHarnessesWith(host({ binaries: ["/usr/local/bin/crush"], ...fake })))
        .find((harness) => harness.id === "crush")
    expect(await crushOf({ env: { OPENROUTER_API_KEY: "or" } }))
      .toMatchObject({ status: "api-key", account: { label: "OPENROUTER_API_KEY" } })
    expect(await crushOf({ files: { "/Users/u/.local/share/crush/providers.json": JSON.stringify(["k"]) } }))
      .toMatchObject({ status: "signed-in", account: { label: "~/.local/share/crush/providers.json" } })
    expect(await crushOf({ files: { "/Users/u/.config/crush/crush.json": JSON.stringify({ providers: { a: "k" } }) } }))
      .toMatchObject({ status: "signed-in", account: { label: "~/.config/crush/crush.json" } })
    // A config holding no credential is not a sign-in, and neither is unparseable text.
    expect(await crushOf({ files: { "/Users/u/.config/crush/crush.json": JSON.stringify({ providers: { a: "" } }) } }))
      .toMatchObject({ status: "binary-only" })
    expect(await crushOf({ files: { "/Users/u/.config/crush/crush.json": "{ not json" } }))
      .toMatchObject({ status: "binary-only" })
  })

  test("amp: AMP_API_KEY, else a secrets file with something in it", async () => {
    const ampOf = async (fake: Fake) =>
      (await detectHarnessesWith(host({ binaries: ["/usr/local/bin/amp"], ...fake })))
        .find((harness) => harness.id === "amp")
    expect(await ampOf({ env: { AMP_API_KEY: "amp" } }))
      .toMatchObject({ status: "api-key", account: { label: "AMP_API_KEY" } })
    expect(await ampOf({ files: { "/Users/u/.config/amp/secrets.json": JSON.stringify({ token: "t" }) } }))
      .toMatchObject({ status: "signed-in", account: { label: "~/.config/amp/secrets.json" } })
    expect(await ampOf({})).toMatchObject({ status: "binary-only" })
  })

  test("cursor-agent: the macOS auth path, the XDG one elsewhere, else CURSOR_API_KEY", async () => {
    const cursorOf = async (fake: Fake) =>
      (await detectHarnessesWith(host({ binaries: ["/usr/local/bin/cursor-agent"], ...fake })))
        .find((harness) => harness.id === "cursor-agent")
    expect(await cursorOf({ files: { "/Users/u/.cursor/auth.json": JSON.stringify({ token: "t" }) } }))
      .toMatchObject({ status: "signed-in", account: { label: "~/.cursor/auth.json" } })
    expect(
      await cursorOf({
        platform: "linux",
        files: { "/Users/u/.config/cursor/auth.json": JSON.stringify({ token: "t" }) }
      })
    ).toMatchObject({ status: "signed-in", account: { label: "~/.config/cursor/auth.json" } })
    expect(
      await cursorOf({
        platform: "linux",
        env: { XDG_CONFIG_HOME: "/xdg" },
        files: { "/xdg/cursor/auth.json": JSON.stringify({ token: "t" }) }
      })
    ).toMatchObject({ status: "signed-in", account: { label: "/xdg/cursor/auth.json" } })
    expect(await cursorOf({ env: { CURSOR_API_KEY: "ck" } }))
      .toMatchObject({ status: "api-key", account: { label: "CURSOR_API_KEY" } })
    expect(await cursorOf({})).toMatchObject({ status: "binary-only" })
  })

  test("hermes: auth.json, then a bare config.yaml, else binary-only", async () => {
    const hermesOf = async (fake: Fake) =>
      (await detectHarnessesWith(host({ binaries: ["/usr/local/bin/hermes"], ...fake })))
        .find((harness) => harness.id === "hermes")
    expect(await hermesOf({ files: { "/Users/u/.hermes/config.yaml": "model: x" } }))
      .toMatchObject({ status: "signed-in", account: { label: "~/.hermes/config.yaml" } })
    expect(await hermesOf({})).toMatchObject({ status: "binary-only" })
  })

  test("pi: a credential in its agent auth.json", async () => {
    const piOf = async (fake: Fake) =>
      (await detectHarnessesWith(host({ binaries: ["/usr/local/bin/pi"], ...fake })))
        .find((harness) => harness.id === "pi")
    expect(await piOf({ files: { "/Users/u/.pi/agent/auth.json": JSON.stringify([{ token: "t" }]) } }))
      .toMatchObject({ status: "signed-in", account: { label: "~/.pi/agent/auth.json" } })
    // Nesting deeper than the walk looks is not a credential it will claim.
    const deep = JSON.stringify([[[[[[[[[["t"]]]]]]]]]])
    expect(await piOf({ files: { "/Users/u/.pi/agent/auth.json": deep } })).toMatchObject({ status: "binary-only" })
    // Neither is a file of numbers.
    expect(await piOf({ files: { "/Users/u/.pi/agent/auth.json": JSON.stringify({ count: 1 }) } }))
      .toMatchObject({ status: "binary-only" })
  })

  test("versions are probed in parallel for installed binaries only, null when the probe fails", async () => {
    const h = host({
      binaries: ["/opt/homebrew/bin/claude", "/opt/homebrew/bin/hermes"],
      versions: { "/opt/homebrew/bin/hermes": null }
    })
    const all = await detectHarnessesWith(h)
    expect(h.probed.sort()).toEqual(["/opt/homebrew/bin/claude", "/opt/homebrew/bin/hermes"])
    expect(all.find((harness) => harness.id === "claude")?.version).toBe("1.2.3")
    expect(all.find((harness) => harness.id === "hermes")?.version).toBeNull()
  })
})

describe("helpers", () => {
  test("parseVersionLine picks the version out of a CLI's banner", () => {
    expect(parseVersionLine("2.1.247 (Claude Code)\n")).toBe("2.1.247")
    expect(parseVersionLine("codex-cli 0.149.1")).toBe("0.149.1")
    expect(parseVersionLine("crush version v0.1.11")).toBe("0.1.11")
    expect(parseVersionLine("kimi, version 1.48.0")).toBe("1.48.0")
    expect(parseVersionLine("0.0.1780433882-g06340c (released 2026-06-02)")).toBe("0.0.1780433882-g06340c")
    expect(parseVersionLine("\n  unknown\n")).toBe("unknown")
    expect(parseVersionLine("")).toBeNull()
  })

  test("parseVersionLine returns a bounded, control-free string for a hostile banner", () => {
    // A planted binary cannot drive the terminal that renders the version field.
    expect(parseVersionLine("\u001b]0;pwned\u0007\u001b[2Jhello\u009b31m\r\u202eevil\n")).toBe("hello31mevil")
    expect(parseVersionLine("\u001b[31m1.2.3\u001b[0m")).toBe("1.2.3")
    expect(parseVersionLine("x".repeat(10_000))).toHaveLength(64)
    expect(parseVersionLine(`1.${"9".repeat(10_000)}`)).toHaveLength(64)
    expect(parseVersionLine("\u001b[2J\u0007")).toBeNull()
  })

  test("decodeJwtClaims never verifies and never throws", () => {
    expect(decodeJwtClaims(jwt({ email: "a@b.c" }))).toEqual({ email: "a@b.c" })
    expect(decodeJwtClaims("not-a-jwt")).toBeNull()
    expect(decodeJwtClaims("a..c")).toBeNull()
    expect(decodeJwtClaims("a.!!!.c")).toBeNull()
    // A payload that decodes to a scalar is not a claim set.
    expect(decodeJwtClaims(`a.${Buffer.from("42").toString("base64url")}.c`)).toBeNull()
    expect(decodeJwtClaims(42)).toBeNull()
  })

  test("probeEnv copies the allowlist and nothing else", () => {
    const env = probeEnv({
      HOME: "/Users/u",
      PATH: "/usr/bin",
      TMPDIR: "",
      ANTHROPIC_API_KEY: "sk",
      SMITHERS_CLOUD_TOKEN: "secret",
      GITHUB_TOKEN: "secret"
    })
    // A --version probe holds no provider key.
    expect(env).toEqual({ NO_COLOR: "1", HOME: "/Users/u", PATH: "/usr/bin" })
    expect(PROBE_ENV_KEYS.filter((key) => key.endsWith("_API_KEY"))).toEqual([])
    // The allowlist is the whole contract: a key absent from it never reaches a probe.
    expect(PROBE_ENV_KEYS).not.toContain("SMITHERS_CLOUD_TOKEN")
    expect(PROBE_ENV_KEYS).not.toContain("GITHUB_TOKEN")
    expect(new Set(PROBE_ENV_KEYS).size).toBe(PROBE_ENV_KEYS.length)
  })

  test("a probe child's PATH keeps only absolute entries", () => {
    const env = probeEnv({ PATH: [".", "node_modules/.bin", "/usr/bin", "", "/bin"].join(delimiter) })
    expect(env.PATH).toBe(["/usr/bin", "/bin"].join(delimiter))
    expect(probeEnv({ PATH: "." })).toEqual({ NO_COLOR: "1" })
  })

  test("modelProbeEnv adds only the credentials that harness's model listing reads", () => {
    const source = {
      HOME: "/Users/u",
      KIMI_API_KEY: "kimi",
      CEREBRAS_API_KEY: "cerebras",
      ANTHROPIC_API_KEY: "anthropic",
      GITHUB_TOKEN: "secret"
    }
    expect(modelProbeEnv("opencode-kimi", source)).toEqual({ NO_COLOR: "1", HOME: "/Users/u", KIMI_API_KEY: "kimi" })
    expect(modelProbeEnv("opencode-cerebras", source))
      .toEqual({ NO_COLOR: "1", HOME: "/Users/u", CEREBRAS_API_KEY: "cerebras" })
    expect(modelProbeEnv("opencode", source)).toEqual({
      NO_COLOR: "1",
      HOME: "/Users/u",
      KIMI_API_KEY: "kimi",
      CEREBRAS_API_KEY: "cerebras",
      ANTHROPIC_API_KEY: "anthropic"
    })
    // A harness with no model listing is never probed for models, so it gets no key.
    expect(modelProbeEnv("claude", source)).toEqual({ NO_COLOR: "1", HOME: "/Users/u" })
    for (const detector of DETECTORS) {
      expect(detector.models?.listCredentials === undefined || detector.models.list !== undefined).toBe(true)
    }
  })

  test("a version probe has a finite budget", () => {
    expect(VERSION_TIMEOUT_MS).toBeGreaterThan(0)
  })
})
