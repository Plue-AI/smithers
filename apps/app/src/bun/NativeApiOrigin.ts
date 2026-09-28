/** A backend the native relay may target: a credential-free http(s) origin with no path, query or fragment. */
export const parseNativeApiOrigin = (value: string): URL => {
  let target: URL
  try { target = new URL(value) }
  catch { throw new Error("Native API origin must be a credential-free HTTP(S) origin.") }
  if (!/^https?:$/.test(target.protocol) || target.username || target.password ||
    target.pathname !== "/" || target.search || target.hash) {
    throw new Error("Native API origin must be a credential-free HTTP(S) origin.")
  }
  return target
}
