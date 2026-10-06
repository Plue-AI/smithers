/**
 * The label a Microsandbox machine records its network under, and how a
 * machine handle's recorded network is read back.
 *
 * The vendor's default network reaches the public internet, so a machine
 * whose configuration records no network booted under it. Every path that
 * reconnects to or restarts an existing machine compares this record before
 * it touches the guest.
 *
 * @internal
 * @since 1.0.0
 */

/**
 * The label recording a machine's network: `none`, `open`, or a vendor policy as JSON.
 *
 * @category constants
 * @since 1.0.0
 */
export const networkLabel = "smithers.network"

/**
 * The network a machine handle's persisted configuration records, or `undefined` for none.
 *
 * @category utilities
 * @since 1.0.0
 */
export const recordedNetwork = (configJson: string): string | undefined => {
  const labels = Reflect.get(Object(JSON.parse(configJson)), "labels")
  const value = Reflect.get(Object(labels), networkLabel)
  return typeof value === "string" ? value : undefined
}
