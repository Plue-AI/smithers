/**
 * Planning and service-spec helpers for `S.Anvil.Fork`.
 *
 * An Anvil fork is a supervised service, so this module resolves the host
 * `anvil` binary (with the typed host refusal as identity when absent) and
 * renders the fork declaration into a supervisor spec: loopback bind,
 * port readiness, and a loopback URL capability in place of the RPC secret.
 * The supervisor resolves the true destination only when Anvil makes its
 * outbound request, so the child argv never contains the credential.
 *
 * @since 0.1.0
 */

import type * as Anvil from "@smthrs/targets/Anvil"
import * as HostProbes from "./internal/HostProbes.ts"
import * as PackageTree from "./PackageTree.ts"
import type * as ServiceSupervisor from "./ServiceSupervisor.ts"

/**
 * Resolves anvil and returns the identity used by the package key.
 *
 * `probes` is the invocation's host-probe cache, so every fork target of one
 * plan shares a single `anvil --version`.
 *
 * @category planning
 * @since 0.1.0
 */
export const resolveAnvil = async (probes: HostProbes.HostProbes = HostProbes.none()) => {
  const path = PackageTree.findOnPath("anvil")
  if (path === undefined) {
    return {
      ok: false as const,
      refusal: "host binary \"anvil\" is not present on PATH",
      identity: { tag: "Anvil", absent: true }
    }
  }
  const probe = await probes.once(["anvil", path, ["--version"], "ambient"], () => PackageTree.probeVersion(path))
  return { ok: true as const, path, identity: { tag: "Anvil", path, probe } }
}

/**
 * Resolves one fork target to the scoped service supervisor.
 *
 * @category planning
 * @since 0.1.0
 */
export const serviceSpec = async (options: {
  readonly label: string
  readonly cwd: string
  readonly attrs: (typeof Anvil.ForkAttrs)["Type"]
  readonly probes?: HostProbes.HostProbes | undefined
}): Promise<ServiceSupervisor.ServiceSpec | { readonly error: string }> => {
  const tool = await resolveAnvil(options.probes)
  if (!tool.ok) return { error: tool.refusal }
  const forkUrlIndex = 6
  const argv: Array<string> = [
    tool.path,
    "--host",
    "127.0.0.1",
    "--port",
    String(options.attrs.port),
    "--fork-url",
    `{secret-url:${options.attrs.forkUrl.env}}`
  ]
  if (options.attrs.forkBlockNumber !== "latest") {
    argv.push("--fork-block-number", String(options.attrs.forkBlockNumber))
  }
  return {
    key: options.label,
    cwd: options.cwd,
    argv: argv as [string, ...Array<string>],
    secretUrls: [{ index: forkUrlIndex, secret: options.attrs.forkUrl }],
    readiness: { port: options.attrs.port },
    stop: { signal: "SIGTERM", grace: "5s" }
  }
}
