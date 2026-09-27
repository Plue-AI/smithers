/** Shared native runtime contracts derived from the composition itself.
 * @since 1.0.0
 */

import type { makeNative } from "./NativeRuntime.ts"

/** Native host API shared by Node and Bun.
 * @since 1.0.0
 * @private
 */
export type NativeRuntimeApi = ReturnType<typeof makeNative>
