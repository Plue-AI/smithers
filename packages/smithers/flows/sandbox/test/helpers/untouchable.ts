/**
 * A dependency double that records every property read, for tests proving a
 * constructor refused before touching what it was handed.
 */
export const untouchable = <A>(): { readonly value: A; readonly touched: Array<PropertyKey> } => {
  const touched: Array<PropertyKey> = []
  const value = new Proxy({}, {
    get: (_target, key) => {
      touched.push(key)
      return undefined
    }
  }) as A
  return { value, touched }
}
