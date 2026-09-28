export function choose(flag: boolean) {
  if (flag) return "positive"
  return "negative"
}
export function optional(input?: { value: number }) {
  return input?.value ?? 3
}
export function late() {
  return "teardown observed"
}
export const location = import.meta.url
