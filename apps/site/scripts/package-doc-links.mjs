import { basename, posix } from "node:path"
export const outputRelFor = (srcRel) => {
  if (srcRel === "api.md") return "reference/api.md"
  if (basename(srcRel) === "README.md") {
    const dir = posix.dirname(srcRel)
    return dir === "." ? "index.md" : `${dir}/index.md`
  }
  return srcRel
}

/** The site route of a synced content path, with leading and trailing slash. */
export const routeFor = (outputRel) => {
  const noExt = outputRel.replace(/\.mdx?$/, "")
  if (noExt === "index") return "/"
  if (noExt.endsWith("/index")) return `/${noExt.slice(0, -"/index".length)}/`
  return `/${noExt}/`
}

