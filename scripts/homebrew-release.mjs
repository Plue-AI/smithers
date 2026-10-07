// @ts-check
import { createHash } from "node:crypto"
import { readFile, writeFile, mkdir, rename, readdir } from "node:fs/promises"
import { join, resolve } from "node:path"
import { execFileSync } from "node:child_process"
import { archiveName } from "./installer-release.mjs"
import { isMain } from "./workspace-packages.mjs"

const hash = bytes => createHash("sha256").update(bytes).digest("hex")
// Homebrew writes name--version locally but fetches name-version from root_url.
export const normalizeBottle = async directory => {
  const metadata = (await readdir(directory)).filter(name => name.endsWith(".bottle.json"))
  if (metadata.length !== 1) throw new Error("Exactly one bottle metadata file required")
  const data = JSON.parse(await readFile(join(directory, metadata[0]), "utf8"))
  const entries = Object.entries(data)
  if (entries.length !== 1) throw new Error("Exactly one bottle formula required")
  const tags = Object.entries(entries[0][1].bottle.tags)
  if (tags.length !== 1 || !/^arm64_/.test(tags[0][0])) throw new Error("Exactly one macOS arm64 bottle required")
  const { filename, local_filename: local, sha256 } = tags[0][1]
  for (const name of [filename, local]) {
    if (typeof name !== "string" || !/^smithers-[A-Za-z0-9_.-]+\.bottle\.tar\.gz$/.test(name)) throw new Error("Unsafe bottle filename")
  }
  if (hash(await readFile(join(directory, local))) !== sha256) throw new Error("Bottle metadata checksum mismatch")
  if (filename !== local) await rename(join(directory, local), join(directory, filename))
}
export const formula = ({ tag, cliHash, bundleHash, sumsHash, root }) => {
  archiveName(tag, "darwin", "arm64") // validate before emitting Ruby or URLs
  for (const value of [cliHash, bundleHash, sumsHash]) if (!/^[a-f0-9]{64}$/.test(value)) throw new Error("Invalid asset digest")
  if (root !== undefined && !/^file:\/\/[A-Za-z0-9/_-]+$/.test(root)) throw new Error("Invalid rehearsal root")
  const base = root ?? `https://github.com/smithersai/smithers/releases/download/${tag}`
  const cli = archiveName(tag, "darwin", "arm64")
  return `class Smithers < Formula
  desc "Self-hosted coding factory"
  homepage "https://github.com/smithersai/smithers"
  url "${base}/HOMEBREW-SHA256SUMS"
  version "${tag.slice(1)}"
  sha256 "${sumsHash}"
  license "MIT"
  require "json"
  require "digest"
  depends_on arch: :arm64
  depends_on :macos
  depends_on "cosign" => :build

  resource "cli" do
    url "${base}/${cli}"
    sha256 "${cliHash}"
  end
  resource "server" do
    url "${base}/smithers-server.tar.gz"
    sha256 "${bundleHash}"
  end
  resource "signature" do
    url "${base}/HOMEBREW-SHA256SUMS.sigstore.json"
  end

  def install
    odie "Use a macOS arm64 bottle" unless Hardware::CPU.arm? && OS.mac?
    odie "A prebuilt bottle is required" unless build.bottle?
    # Fetch both archives, but do not stage/extract until signature verification.
    cli = resource("cli").fetch
    server = resource("server").fetch
    signature = resource("signature").fetch
    system Formula["cosign"].opt_bin/"cosign", "verify-blob",
      "--bundle", signature.to_s,
      "--certificate-oidc-issuer", "https://token.actions.githubusercontent.com",
      "--certificate-identity", "https://github.com/smithersai/smithers/.github/workflows/release.yml@refs/tags/${tag}",
      cached_download.to_s
    expected = "${cliHash}  ${cli}\\n${bundleHash}  smithers-server.tar.gz\\n"
    odie "Signed asset set mismatch" unless File.read(cached_download) == expected
    resource("server").stage do
      manifest = JSON.parse(File.read("manifest.json"))
      odie "Invalid bundle manifest" unless manifest["version"] == 1 && manifest["platform"] == "darwin-arm64"
      files = manifest.fetch("files")
      paths = files.map { |entry| entry.fetch("path") }
      odie "Duplicate bundle path" unless paths.uniq == paths
      files.each do |entry|
        path = entry.fetch("path")
        odie "Unsafe bundle path" if Pathname.new(path).absolute? || path.split("/").include?("..")
        if entry["symlink"]
          odie "Bundle link mismatch" unless File.symlink?(path) && File.readlink(path) == entry["symlink"]
        else
          odie "Bundle checksum mismatch" unless File.file?(path) && !File.symlink?(path) && Digest::SHA256.file(path).hexdigest == entry.fetch("sha256")
          odie "Bundle mode mismatch" unless File.stat(path).mode & 0777 == entry.fetch("mode")
        end
      end
      libexec.install Dir["*", ".[^.]*"]
    end
    resource("cli").stage { (prefix/"cli").install Dir["*"] }
    system "/usr/bin/codesign", "--verify", "--strict", libexec/"bin/msb"
    entitlements = Utils.safe_popen_read("/usr/bin/codesign", "-d", "--entitlements", ":-", libexec/"bin/msb")
    odie "Missing hypervisor entitlement" unless entitlements.include?("com.apple.security.hypervisor")
    # The assembler signs msb; re-signing here would invalidate its manifest hash.
    bin.install_symlink prefix/"cli/smithers" => "smthrs"
  end

  test do
    system bin/"smthrs", "--version"
  end
end
`
}

export const prepare = async (directory, tag, root) => {
  directory = resolve(directory)
  const cli = archiveName(tag, "darwin", "arm64")
  const cliHash = hash(await readFile(join(directory, cli)))
  const bundleHash = hash(await readFile(join(directory, "smithers-server.tar.gz")))
  const sums = `${cliHash}  ${cli}\n${bundleHash}  smithers-server.tar.gz\n`
  await writeFile(join(directory, "HOMEBREW-SHA256SUMS"), sums)
  await mkdir(join(directory, "Formula"), { recursive: true })
  await writeFile(join(directory, "Formula/smithers.rb"), formula({ tag, cliHash, bundleHash, sumsHash: hash(sums), root }))
}

export const requireQualification = async ({ sha, tag, appID, token, request = fetch }) => {
  archiveName(tag, "darwin", "arm64")
  if (!/^[a-f0-9]{40}$/.test(sha) || !/^[1-9][0-9]*$/.test(appID ?? "") || !token) throw new Error("Release qualification identity is not configured")
  const response = await request(`https://api.github.com/repos/smithersai/smithers/commits/${sha}/check-runs?per_page=100`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" }
  })
  if (!response.ok) throw new Error(`Cannot authenticate release qualification: ${response.status}`)
  const data = await response.json()
  for (const name of ["C-REL-02", "C-J1-01", "C-J1-04"]) {
    const check = data.check_runs?.filter(check => check.name === name && String(check.app?.id) === appID).sort((a, b) => (b.id ?? 0) - (a.id ?? 0))[0]
    if (!check || check.head_sha !== sha || check.status !== "completed" || check.conclusion !== "success") throw new Error(`Missing authenticated ${name} receipt for ${sha}`)
  }
}

if (isMain(import.meta)) {
  const [command, directory, tag, root] = process.argv.slice(2)
  if (command === "prepare") await prepare(directory, tag, root)
  else if (command === "normalize-bottle") await normalizeBottle(directory)
  else if (command === "qualify") {
    const sha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim()
    execFileSync("git", ["merge-base", "--is-ancestor", sha, "origin/main"])
    await requireQualification({ sha, tag, appID: process.env.RELEASE_QUALIFICATION_APP_ID, token: process.env.GITHUB_TOKEN })
  } else throw new Error("Usage: homebrew-release.mjs prepare|qualify|normalize-bottle <directory> <tag> [file-root]")
}
