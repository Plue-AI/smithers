import { isMain, libraryPackages } from "./workspace-packages.mjs"
const legacySlugs = { "@smthrs/patterns": "smithers-patterns", "@smthrs/sync": "smithers-sync" }
export const sites = libraryPackages().filter(({ manifest }) => !manifest.private).map(({ dir, name, manifest }) => {
  const slug = legacySlugs[name] ?? name.replace(/^@[^/]+\//, "")
  return { dir, name, slug, title: name, description: manifest.description ?? "", domain: `${slug}.smithers.sh` }
})
export const redirectMap = Object.fromEntries(sites.map(({ slug, dir }) => [slug, `https://github.com/smithersai/smithers/tree/main/${dir}/docs`]))
export const redirectLocation = (url) => {
  const slug = new URL(url).hostname.replace(/\.smithers\.sh$/, "")
  return Object.hasOwn(redirectMap, slug) ? redirectMap[slug] : "https://github.com/smithersai/smithers/blob/main/README.md"
}

if (isMain(import.meta)) console.log(JSON.stringify(redirectMap, null, 2))
