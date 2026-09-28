# @smthrs/harness-detect

Which coding-agent CLIs this machine has, and which account each one is
signed into.

Given a host, the package answers one question for every harness id in the
`HARNESS_IDS` contract (`claude`, `codex`, `gemini`, `kimi`, `opencode`,
`opencode-kimi`, `opencode-cerebras`, `crush`, `amp`, `cursor-agent`,
`hermes`, `pi`): is the binary installed, what version is it, is it signed
in, and how does it take a model on its command line. The answer is a
`Harness` row from `@smthrs/rpc/LocalApp` — the same shape the app's
`GET /api/harnesses` returns.

The package spawns nothing, reads no file, and knows no runtime. Every host
fact arrives through an injected `HarnessHost`, which is what makes the whole
table assertable over fixtures instead of over whatever happens to be
installed on the developer's laptop.
Path formatting and `PATH` separators follow `host.platform`.

## What it detects

- **The binary.** Explicit candidate dirs are searched before `PATH`, in
  order: `~/.local/bin`, `~/.bun/bin`, `/opt/homebrew/bin`, `/usr/local/bin`,
  the nvm node dirs newest first, `~/.cargo/bin`, `~/.opencode/bin`. A Finder
  launch inherits the launchd `PATH`, which holds none of these, so the
  candidate dirs are not an optimization. On Windows the two POSIX prefixes are
  skipped and a binary matches only with a `PATHEXT` extension (default
  `.COM;.EXE;.BAT;.CMD`), so `claude.cmd` is found and the POSIX shim beside it
  is not. A relative `PATH` entry (`.`, `node_modules/.bin`) is skipped, so a
  cloned repository in the cwd cannot plant a binary for detection to probe.
- **The version.** `<binary> --version`, delegated to the host, parsed with
  `parseVersionLine` — `"2.1.247 (Claude Code)"` is `2.1.247` and
  `"crush version v0.1.11"` is `0.1.11`. The result has escape sequences and
  control characters stripped and is at most `VERSION_MAX_LENGTH` (64)
  characters, so a hostile binary cannot drive the terminal that renders it.
- **The account.** Per vendor, off this user's own files: `.claude.json`'s (in `CLAUDE_CONFIG_DIR` when set, then `~`)
  `oauthAccount` then `.credentials.json`, the Codex `auth.json` `id_token`'s
  `email` claim (decoded, never verified, never returned), the OpenCode
  `auth.json` providers, and so on, with the vendor's API-key environment
  variable as the last signal. The status is one of `signed-in`, `api-key`,
  `binary-only`, `unavailable`.
- **The model flag.** `harnessModelSpec(id)` gives the binary and the flag
  that precedes a model id, and `harnessModels(id)` adds the verified
  suggestions and the argv that lists models. Every entry is read off the
  installed binary's own `--help`; a harness whose help names no model flag
  has no entry and never runs as a custom agent.

## The host interface

```ts
interface HarnessHost {
  readonly env: Readonly<Record<string, string | undefined>>
  readonly home: string
  readonly platform: string
  /** Entries of a directory, or [] when it does not exist. */
  readonly listDir: (dir: string) => ReadonlyArray<string>
  /** True for an existing regular file (a symlink to one counts). */
  readonly isFile: (path: string) => boolean
  /** File text, or null when it cannot be read. */
  readonly readText: (path: string) => string | null
  /** `<binary> --version`, or null when it fails or exceeds the host's timeout. */
  readonly version: (binary: string) => Promise<string | null>
}
```

Four reads and one probe. Nothing in the table reaches past them, so a test
host is a record of fixtures and a production host is thirty lines of
`node:fs`.

## Example

```ts
import { detectHarnessesWith, parseVersionLine, probeEnv, VERSION_TIMEOUT_MS } from "@smthrs/harness-detect"
import type { HarnessHost } from "@smthrs/harness-detect"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"

const host: HarnessHost = {
  env: process.env,
  home: process.env.HOME ?? homedir(),
  platform: process.platform,
  listDir: (dir) => {
    try {
      return readdirSync(dir)
    } catch {
      return []
    }
  },
  isFile: (path) => {
    try {
      return statSync(path).isFile()
    } catch {
      return false
    }
  },
  readText: (path) => {
    try {
      return readFileSync(path, "utf8")
    } catch {
      return null
    }
  },
  version: async (binary) => {
    const child = Bun.spawn([binary, "--version"], {
      stdout: "pipe",
      stderr: "ignore",
      stdin: "ignore",
      timeout: VERSION_TIMEOUT_MS,
      killSignal: "SIGKILL",
      // The probe sees the allowlist and nothing else, so a session token
      // never reaches a CLI that is only reporting its version.
      env: probeEnv(process.env)
    })
    const [code, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()])
    return code === 0 ? parseVersionLine(stdout) : null
  }
}

for (const harness of await detectHarnessesWith(host)) {
  console.log(harness.id, harness.status, harness.version ?? "-")
}
```

The live adapter is `apps/app/src/bun/Harnesses.ts`, which adds a per-binary
version cache and runs each probe under the app's seatbelt profile.

## Probe safety

`PROBE_ENV_KEYS` is the complete set of environment variables a `--version`
probe child may see, and `probeEnv` builds that environment plus `NO_COLOR`.
Anything else — `SMITHERS_CLOUD_TOKEN`, `GITHUB_TOKEN`, every provider API
key — is dropped, because a process that only prints its version has no
business holding a credential. `probeEnv` also drops relative `PATH` entries,
so a probed script's `#!/usr/bin/env node` cannot resolve an interpreter out
of the cwd.

A model-list probe uses `modelProbeEnv(id, source)` instead: `probeEnv` plus
only the `listCredentials` of that harness's model table (`opencode models
kimi-for-coding` gets `KIMI_API_KEY` and nothing else). A harness with no
model listing gets no key. Sandboxing the probe is the adapter's job; the
allowlist is shared so every adapter drops the same things.

## Exports

| Export                                       | What it is                                                         |
| -------------------------------------------- | ------------------------------------------------------------------ |
| `detectHarnessesWith(host)`                  | The whole table: one `Harness` row per contract id, in order       |
| `HarnessHost`                                | The injected host interface                                        |
| `HarnessId`                                  | One of `HARNESS_IDS`                                               |
| `DETECTORS`                                  | The table itself: binary, launch argv, model table, sign-in signal |
| `Detector`, `Signal`, `HarnessModels`        | The table's types                                                  |
| `harnessCandidateDirs(host)`                 | The dirs searched before `PATH`, in order                          |
| `findBinary(name, host)`                     | The first candidate dir, then `PATH` entry, holding a binary       |
| `harnessModels(id)` / `harnessModelSpec(id)` | The model flag, suggestions and list argv                          |
| `decodeJwtClaims(token)`                     | A JWT payload, unverified, never throwing                          |
| `parseVersionLine(output)`                   | The version out of a CLI banner                                    |
| `probeEnv(source)` / `PROBE_ENV_KEYS`        | The environment a `--version` probe child gets                     |
| `modelProbeEnv(id, source)`                  | The environment a model-list probe child gets                      |
| `VERSION_TIMEOUT_MS`                         | The budget one `--version` gets                                    |
| `VERSION_MAX_LENGTH`                         | The longest version string `parseVersionLine` returns              |
