/**
 * Defines the observable state of the scripted sandbox provider.
 *
 * @since 0.1.0
 */

/**
 * What a scripted sandbox provider has been asked to do, for assertions.
 *
 * `files` is the guest tree itself: reads consult it, writes land in it, and a
 * test observes results by looking at it. Paths are the exact strings callers
 * used, because the double models a machine, not a path resolver.
 *
 * @category models
 * @since 0.1.0
 */
export interface TestSessionState {
  readonly acquired: Array<string>
  readonly commands: Array<string>
  /** The standard input each spawned command received, by spawn order. */
  readonly inputs: Array<Uint8Array | undefined>
  readonly files: Map<string, Uint8Array>
  /** Sessions released, forked children included. */
  released: number
  /** Every forked child's session key, in fork order. */
  readonly forked: Array<string>
  /** The guest tree of each live forked child, by session key. */
  readonly children: Map<string, Map<string, Uint8Array>>
}
