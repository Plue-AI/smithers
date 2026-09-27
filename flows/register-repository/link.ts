/** One freeform repository link to its canonical GitHub `owner/repo`. */

const OWNER = /^[a-z0-9](?:[a-z0-9-]{0,38})$/
const NAME = /^[a-z0-9._-]{1,100}$/

/**
 * Accepts `https://github.com/o/r[.git][/tree/...]`, `github.com/o/r`,
 * `git@github.com:o/r.git`, `ssh://git@github.com/o/r` and bare `o/r`.
 * Returns undefined for anything that is not one GitHub repository.
 */
export const canonicalRepo = (link: string): string | undefined => {
  const text = link.trim().toLowerCase()
  if (text === "" || /\s/.test(text)) return undefined
  const ssh = /^(?:ssh:\/\/)?git@github\.com[:/](.+)$/.exec(text)
  const web = /^(?:https?:\/\/)?(?:www\.)?github\.com\/(.+)$/.exec(text)
  const rest = ssh?.[1] ?? web?.[1] ?? (/^[^/:.][^/:]*\/[^/:]+$/.test(text) ? text : undefined)
  if (rest === undefined) return undefined
  const [owner, raw] = rest.split(/[?#]/)[0]!.split("/")
  const name = raw?.replace(/\.git$/, "")
  if (owner === undefined || name === undefined || !OWNER.test(owner) || !NAME.test(name)) return undefined
  if (name === "." || name === "..") return undefined
  return `${owner}/${name}`
}
