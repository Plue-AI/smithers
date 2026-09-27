/**
 * The harness table for one host.
 *
 * @since 0.1.0
 */

import type { Harness } from "@smthrs/rpc/LocalApp"
import { DETECTORS } from "./Detectors.ts"
import { findBinary } from "./HarnessHost.ts"
import type { HarnessHost } from "./HarnessHost.ts"

/**
 * Every harness id, in contract order, whether installed or not.
 *
 * A row with no binary is `unavailable` and is never probed, even when its
 * credentials are on disk. Version probes for the installed binaries run in
 * parallel, so a caller waits for the slowest CLI once rather than for the
 * sum of them.
 *
 * @category detection
 * @since 0.1.0
 */
export const detectHarnessesWith = async (host: HarnessHost): Promise<Array<Harness>> => {
  const found = DETECTORS.map((detector) => ({ detector, binary: findBinary(detector.binary, host) }))
  const versions = await Promise.all(
    found.map(({ binary }) => (binary === null ? Promise.resolve(null) : host.version(binary)))
  )
  return found.map(({ binary, detector }, index) => {
    const signal = binary === null ? null : detector.signal(host)
    return {
      id: detector.id,
      displayName: detector.displayName,
      binary,
      version: versions[index] ?? null,
      status: signal === null ? "unavailable" : signal.status,
      account: signal === null ? null : signal.account,
      launch: { argv: [...detector.launch] },
      ...(detector.models === undefined
        ? {}
        : { models: { suggestions: [...detector.models.suggestions], listable: detector.models.list !== undefined } })
    }
  })
}
