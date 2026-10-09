import { mkdirSync, realpathSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MODEL_CREDENTIAL_ENV_PREFIX } from "@smthrs/rpc/ConfiguredModel"
import { DEFAULT_CLOUD_API, startLocalServer } from "../src/bun/server"
import { agentLauncher, type LaunchAgent } from "../src/bun/AgentLaunch"
import type { LocalServerOptions } from "../src/bun/server"

/** Test-only composition. A stubbed model is not permission to inspect host credentials. */
export const browserTestOptions = (
  root: string,
  distDir: string,
  env: Readonly<Record<string, string | undefined>>
): LocalServerOptions => {
  const port = Number(env.SMITHERS_LOCAL_PORT ?? "0")
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid browser-test server port")
  const realChat = env.SMITHERS_CHAT_STUB === "0"
  // #3730: Codex and Claude Code start as fixture CLIs in a scratch directory, each writing into a home of its own.
  const launch: Partial<Record<LaunchAgent, { readonly cli: string; readonly home: string }>> = {
    ...(env.SMITHERS_E2E_CODEX_CLI === undefined ? {} : { codex: { cli: env.SMITHERS_E2E_CODEX_CLI, home: launchHome(root, "codex") } }),
    ...(env.SMITHERS_E2E_CLAUDE_CLI === undefined ? {} : { "claude-code": { cli: env.SMITHERS_E2E_CLAUDE_CLI, home: launchHome(root, "claude-code") } })
  }
  // The real-model tier explicitly passes named fixture providers. Neither
  // ordinary browser tests nor that tier inherit unrelated host model keys.
  const modelEnv = realChat ? Object.fromEntries(Object.entries(env).filter(
    (entry): entry is [string, string] => entry[0].startsWith(MODEL_CREDENTIAL_ENV_PREFIX) && entry[1] !== undefined
  )) : {}
  return {
    port,
    distDir,
    cloudMode: realChat ? "hybrid" : "offline",
    // The fixture may exercise the cloud tunnel; it never restores a stored login.
    // Conversation execution belongs to the composed install backend.
    cloudApi: realChat ? env.SMITHERS_CLOUD_API ?? DEFAULT_CLOUD_API : null,
    cloudKeychain: {
      read: async () => null,
      write: async () => {},
      remove: async () => {}
    },
    identityUpstream: null,
    env: modelEnv,
    home: root,
    stateDir: join(root, "state"),
    ...(launch.codex === undefined && launch["claude-code"] === undefined ? {} : { agentLauncher: agentLauncher({
      cwd: launchDirectory(root), home: root,
      agents: Object.fromEntries((Object.keys(launch) as LaunchAgent[]).map(agent => [agent, {
        command: [process.execPath, launch[agent]!.cli],
        env: { [agent === "codex" ? "CODEX_HOME" : "CLAUDE_CONFIG_DIR"]: launch[agent]!.home },
        roots: async () => [join(launch[agent]!.home, sessionsDirectory[agent])]
      }]))
    }) })
  }
}

/** Where each agent files its sessions under its home. */
const sessionsDirectory: Record<LaunchAgent, string> = { codex: "sessions", "claude-code": "projects" }
/* The reader refuses a path through a link (macOS's /var is one), so a launch home is named by its real path. */
const launchHome = (root: string, agent: LaunchAgent): string => {
  const home = join(root, `${agent}-launch`)
  mkdirSync(join(home, sessionsDirectory[agent]), { recursive: true })
  return realpathSync(home)
}
const launchDirectory = (root: string): string => {
  const directory = join(root, "work")
  mkdirSync(directory, { recursive: true })
  return directory
}

export const startBrowserTestHost = async (
  distDir: string,
  env: Readonly<Record<string, string | undefined>> = process.env
) => {
  const root = await mkdtemp(join(tmpdir(), "smithers-browser-test-"))
  // Retain the owned fixture if startup fails: a partial server startup has
  // not yet handed us its shutdown handle, so deleting underneath it is unsafe.
  const server = await startLocalServer(browserTestOptions(root, distDir, env))
  let stopping: Promise<void> | undefined
  return {
    ...server,
    stop: (): Promise<void> => stopping ??= server.stop().then(() => rm(root, { recursive: true, force: true }))
  }
}
