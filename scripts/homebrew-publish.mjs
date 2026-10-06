// @ts-check
import { readFile, readdir } from "node:fs/promises"
import { createHash } from "node:crypto"
import { join } from "node:path"
import { archiveName, verifyInstallerRelease } from "./installer-release.mjs"
import { requireQualification } from "./homebrew-release.mjs"
import { execFileSync } from "node:child_process"

const [command, directory, tag] = process.argv.slice(2)
archiveName(tag, "darwin", "arm64")
const token = process.env.GITHUB_TOKEN
if (!token) throw new Error("Publication token missing")
const sha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim()
execFileSync("git", ["merge-base", "--is-ancestor", sha, "origin/main"])
await requireQualification({ sha, tag, appID: process.env.RELEASE_QUALIFICATION_APP_ID, token: process.env.RELEASE_QUALIFICATION_TOKEN })
// Re-verify bytes and tag-bound signatures immediately before either write.
await verifyInstallerRelease({ directory, tag })
for (const name of ["HOMEBREW-SHA256SUMS", "HOMEBREW-BOTTLE-SHA256SUMS"]) {
  execFileSync("cosign", ["verify-blob", "--bundle", `${name}.sigstore.json`,
    "--certificate-oidc-issuer", "https://token.actions.githubusercontent.com",
    "--certificate-identity", `https://github.com/smithersai/smithers/.github/workflows/release.yml@refs/tags/${tag}`, name], { cwd: directory, stdio: "inherit" })
  const lines = (await readFile(join(directory, name), "utf8")).trim().split("\n")
  if (lines.length !== (name === "HOMEBREW-SHA256SUMS" ? 2 : 1)) throw new Error("Invalid signed asset set")
  for (const line of lines) {
    const match = /^([a-f0-9]{64})  (?:\.\/)?([A-Za-z0-9_.-]+)$/.exec(line)
    if (!match || createHash("sha256").update(await readFile(join(directory, match[2]))).digest("hex") !== match[1]) throw new Error("Release asset checksum mismatch")
  }
}
const api = async (path, method = "GET", body) => {
  const response = await fetch(`https://api.github.com/repos/${path}`, { method,
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  if (!response.ok) { const error = new Error(`GitHub ${method} ${path}: ${response.status}`); error.status = response.status; throw error }
  return response.json()
}
if (command === "assets") {
  let release
  try { release = await api(`smithersai/smithers/releases/tags/${tag}`) }
  catch (error) {
    if (error.status !== 404) throw error
    release = await api("smithersai/smithers/releases", "POST", { tag_name: tag, target_commitish: sha, name: tag, draft: true, prerelease: tag.includes("-") })
  }
  const names = await readdir(directory)
  if (names.filter(name => name.endsWith(".bottle.tar.gz")).length !== 1) throw new Error("Exactly one arm64 bottle required")
  const publishNames = [
    ...[["darwin", "arm64"], ["darwin", "x64"], ["linux", "arm64"], ["linux", "x64"]].map(([os, arch]) => archiveName(tag, os, arch)),
    "smithers-server.tar.gz", ...names.filter(name => name.endsWith(".bottle.tar.gz")),
    "SHA256SUMS", "SHA256SUMS.sigstore.json", "HOMEBREW-SHA256SUMS", "HOMEBREW-SHA256SUMS.sigstore.json",
    "HOMEBREW-BOTTLE-SHA256SUMS", "HOMEBREW-BOTTLE-SHA256SUMS.sigstore.json"
  ]
  for (const name of publishNames) {
    const bytes = await readFile(join(directory, name))
    const existing = release.assets?.find(asset => asset.name === name)
    if (existing) {
      const existingResponse = await fetch(`https://api.github.com/repos/smithersai/smithers/releases/assets/${existing.id}`, { headers: { authorization: `Bearer ${token}`, accept: "application/octet-stream" } })
      if (!existingResponse.ok || createHash("sha256").update(Buffer.from(await existingResponse.arrayBuffer())).digest("hex") !== createHash("sha256").update(bytes).digest("hex")) throw new Error(`Existing release asset differs: ${name}`)
      continue
    }
    const response = await fetch(`${release.upload_url.replace(/\{.*$/, "")}?name=${encodeURIComponent(name)}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/octet-stream" }, body: bytes })
    if (!response.ok) throw new Error(`Asset upload ${name}: ${response.status}`)
  }
  if (release.draft) await api(`smithersai/smithers/releases/${release.id}`, "PATCH", { draft: false })
} else if (command === "tap") {
  const repo = "smithersai/homebrew-tap"
  const info = await api(repo)
  let base
  try { base = await api(`${repo}/git/ref/heads/${info.default_branch}`) }
  catch (error) {
    if (error.status !== 404 && error.status !== 409) throw error
    // The empty tap needs a parent commit before it can receive a bump PR.
    await api(`${repo}/contents/README.md`, "PUT", {
      message: "Initialize qualified Smithers tap", branch: info.default_branch,
      content: Buffer.from("# Smithers Homebrew tap\n\nbrew install smithersai/tap/smithers\n").toString("base64")
    })
    base = await api(`${repo}/git/ref/heads/${info.default_branch}`)
  }
  const branch = `smithers-${tag}`
  await api(`${repo}/git/refs`, "POST", { ref: `refs/heads/${branch}`, sha: base.object.sha })
  let previous
  const response = await fetch(`https://api.github.com/repos/${repo}/contents/Formula/smithers.rb`, { headers: { authorization: `Bearer ${token}` } })
  if (response.ok) previous = (await response.json()).sha
  else if (response.status !== 404) throw new Error(`Tap formula lookup: ${response.status}`)
  await api(`${repo}/contents/Formula/smithers.rb`, "PUT", { message: `Bump smithers to ${tag}`, branch, content: (await readFile(join(directory, "Formula/smithers.rb"))).toString("base64"), ...(previous ? { sha: previous } : {}) })
  await api(`${repo}/pulls`, "POST", { title: `smithers ${tag}`, head: branch, base: info.default_branch, body: `Qualified macOS arm64 bottle and GitHub Release assets for ${sha}.` })
} else throw new Error("Usage: homebrew-publish.mjs assets|tap <directory> <tag>")
