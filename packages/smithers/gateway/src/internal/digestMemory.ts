/** Encoded retained-data accounting for private diagnosis state.
 * @since 1.0.0
 */

const sizes = new WeakMap<object, number>()
const encoder = new TextEncoder()

/** Measures retained JSON-shaped data without keeping another copy.
 * @category utilities
 * @since 1.0.0
 */
export const encodedBytes = (value: unknown): number => encoder.encode(JSON.stringify(value)).byteLength

/** Associates a digest with its compact identity ledger's byte budget.
 * @category utilities
 * @since 1.0.0
 */
export const recordDigestBytes = (digest: object, bytes: number): void => {
  sizes.set(digest, bytes)
}

/** Includes private scalar contributions in the projection retention budget.
 * @category utilities
 * @since 1.0.0
 */
export const retainedDigestBytes = (digest: object | undefined): number =>
  digest === undefined ? 0 : sizes.get(digest) ?? encodedBytes(digest)
