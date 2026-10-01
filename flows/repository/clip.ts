/**
 * Clips one string to a byte budget without splitting a surrogate pair. Every
 * Jev classifier in the flows holds its state to the same 32 KiB, so they all
 * clip the same way. It lives apart from `jev-checks.ts` so a classifier can
 * clip without loading the host judge.
 */
const encoder = new TextEncoder()
const bytes = (value: string): number => encoder.encode(value).length

export const clip = (value: string, limit: number): string => {
  if (limit <= 0) return ""
  if (bytes(value) <= limit) return value
  let end = Math.min(value.length, limit)
  while (end > 0 && bytes(value.slice(0, end)) > limit) end -= 1
  if (end > 0 && value.codePointAt(end - 1)! >= 0xd800 && value.codePointAt(end - 1)! <= 0xdbff) end -= 1
  return value.slice(0, end)
}
