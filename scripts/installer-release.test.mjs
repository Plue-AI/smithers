import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { archiveName, packInstaller, publishInstallerRelease, signInstallerRelease, verifyInstallerRelease } from "./installer-release.mjs"
import { integrity, recordSmokeSuccess } from "./publish-release.mjs"
import { parseWorkflow } from "./release-rehearsal.mjs"
import { repoRoot } from "./workspace-packages.mjs"

const tag = "v1.0.0-rc.0"
const version = tag.slice(1)
const sourceSha = "a".repeat(40)
const fixtureCandidateIntegrity = integrity(Buffer.from("fixture candidate"))
const targets = [["linux", "x64"], ["linux", "arm64"], ["darwin", "x64"], ["darwin", "arm64"]]

const temp = async (body) => {
  const root = await mkdtemp(join(tmpdir(), "smithers-installer-test-"))
  try { return await body(root) }
  finally { await rm(root, { recursive: true, force: true }) }
}

const packedCli = async (root) => {
  const source = join(root, "cli-source")
  const packDirectory = join(root, "packs")
  await mkdir(join(source, "bin"), { recursive: true })
  await mkdir(packDirectory)
  await writeFile(join(source, "package.json"), JSON.stringify({
    name: "@smthrs/cli", version, type: "module", bin: { smithers: "bin/smithers.mjs" }, files: ["bin"]
  }))
  await writeFile(join(source, "bin", "smithers.mjs"), [
    "#!/usr/bin/env node",
    "if (process.argv[2] === '--version') console.log('1.0.0-rc.0')",
    "else if (process.argv[2] === '--help') console.log('smithers help')",
    "else if (process.argv.slice(2).includes('--json')) console.log(JSON.stringify({ok: true, command: process.argv.slice(2)}))",
    "else console.log(JSON.stringify({args: process.argv.slice(2), execPath: process.execPath}))"
  ].join("\n") + "\n")
  await chmod(join(source, "bin", "smithers.mjs"), 0o755)
  const filename = execFileSync("npm", ["pack", "--pack-destination", packDirectory, "--silent"], { cwd: source, encoding: "utf8" }).trim()
  const entry = { name: "@smthrs/cli", version, filename, integrity: integrity(await readFile(join(packDirectory, filename))) }
  const candidate = { schemaVersion: 1, source: { sha: sourceSha, tag, dirty: false }, packages: [entry] }
  await writeFile(join(packDirectory, "manifest.json"), JSON.stringify(candidate.packages))
  await writeFile(join(packDirectory, "release-manifest.json"), JSON.stringify(candidate))
  await recordSmokeSuccess(packDirectory, candidate)
  return { packDirectory, candidate }
}

test("archive names map the four supported release targets and reject unsupported targets", () => {
  assert.deepEqual(targets.map(([platform, arch]) => archiveName(tag, platform, arch)), [
    `smithers-${tag}-linux-amd64.tar.gz`, `smithers-${tag}-linux-arm64.tar.gz`,
    `smithers-${tag}-darwin-amd64.tar.gz`, `smithers-${tag}-darwin-arm64.tar.gz`
  ])
  for (const [platform, arch] of [["win32", "x64"], ["linux", "ia32"], ["darwin", "ppc64"]]) {
    assert.throws(() => archiveName(tag, platform, arch), /unsupported|platform|arch/i)
  }
})

test("packs the tested npm CLI with an adjacent Node runtime and a relocatable launcher", { timeout: 300_000 }, () => temp(async (root) => {
  const { packDirectory } = await packedCli(root)
  const outputDirectory = join(root, "out")
  await packInstaller({ packDirectory, outputDirectory, tag })
  const filename = archiveName(tag, process.platform, process.arch)
  const archive = join(outputDirectory, filename)
  const listing = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" }).trim().split("\n").map((path) => path.replace(/^\.\//, ""))
  for (const expected of ["smithers", "runtime/node", "node_modules/@smthrs/cli/bin/smithers.mjs"]) {
    assert.ok(listing.includes(expected), `archive must include ${expected}`)
  }
  // An archive with only the launcher as its first tar member can appear to
  // work in a simple listing but lose the CLI payload during extraction.
  assert.ok(listing.length > 3)
  const ownerLine = execFileSync("tar", ["-tvzf", archive], { encoding: "utf8" }).split("\n").find((line) => line.endsWith(" smithers"))
  assert.match(ownerLine ?? "", /\b(?:root\s+root|0\s+0|root\/root|0\/0)\b/, "launcher owner in archive must be root")
  const relocated = join(root, "relocated install")
  await mkdir(relocated)
  execFileSync("tar", ["-xzf", archive, "-C", relocated])
  const launcher = join(relocated, "smithers")
  assert.equal(execFileSync(launcher, ["--version"], { encoding: "utf8" }).trim(), version)
  const output = JSON.parse(execFileSync(launcher, ["echo", "a b", "quoted'word"], { encoding: "utf8" }))
  assert.deepEqual(output.args, ["echo", "a b", "quoted'word"])
  assert.equal(output.execPath, await realpath(join(relocated, "runtime", "node")))
  const link = join(root, "linked-smithers")
  await symlink(launcher, link)
  assert.deepEqual(JSON.parse(execFileSync(link, ["echo", "through-link"], { encoding: "utf8" })).args, ["echo", "through-link"])
}))

test("packing refuses missing or mismatched smoke evidence and changed tarball bytes", { timeout: 120_000 }, () => temp(async (root) => {
  const { packDirectory, candidate } = await packedCli(root)
  const outputDirectory = join(root, "out")
  await rm(join(packDirectory, "smoke-evidence.json"))
  await assert.rejects(packInstaller({ packDirectory, outputDirectory, tag }), /smoke|ENOENT/i)
  await recordSmokeSuccess(packDirectory, candidate)
  await writeFile(join(packDirectory, "release-manifest.json"), JSON.stringify({ ...candidate, source: { ...candidate.source, tag: "v2.0.0" } }))
  await assert.rejects(packInstaller({ packDirectory, outputDirectory, tag }), /tag|smoke|manifest/i)
  await writeFile(join(packDirectory, "release-manifest.json"), JSON.stringify(candidate))
  await writeFile(join(packDirectory, candidate.packages[0].filename), "changed")
  await assert.rejects(packInstaller({ packDirectory, outputDirectory, tag }), /integrity|tarball/i)
  assert.deepEqual((await readdir(outputDirectory).catch(() => [])).filter((name) => name.endsWith(".tar.gz")), [])
}))

const releaseFiles = async (root, releaseTag = tag) => {
  await mkdir(root, { recursive: true })
  for (const [platform, arch] of targets) {
    const archive = archiveName(releaseTag, platform, arch)
    const bytes = Buffer.from(`${platform}-${arch}\n`)
    await writeFile(join(root, archive), bytes)
    await writeFile(join(root, `${archive}.json`), JSON.stringify({
      schemaVersion: 1, status: "passed", archive,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      candidateIntegrity: fixtureCandidateIntegrity,
      source: { sha: sourceSha, tag: releaseTag, dirty: false },
      platform, arch, version: releaseTag.slice(1)
    }))
  }
}

const trustedEnv = {
  GITHUB_REPOSITORY: "smithersai/smithers",
  GITHUB_REF: `refs/tags/${tag}`,
  GITHUB_WORKFLOW_REF: `smithersai/smithers/.github/workflows/release.yml@refs/tags/${tag}`,
  INSTALLER_SOURCE_SHA: sourceSha,
  INSTALLER_CANDIDATE_INTEGRITY: fixtureCandidateIntegrity
}

test("release workflow builds all four native archives before tag-bound signing and publication", async () => {
  const release = parseWorkflow(await readFile(join(repoRoot, ".github", "workflows", "release.yml"), "utf8"))
  const build = release.jobs["installer-archive"]
  const publish = release.jobs["installer-publish"]
  assert.deepEqual(build.strategy.matrix.include.map(({ platform }) => platform).sort(), [
    "darwin-amd64", "darwin-arm64", "linux-amd64", "linux-arm64"
  ])
  assert.equal(build.needs, "publish")
  assert.equal(publish.needs, "installer-archive")
  assert.deepEqual(publish.concurrency, { group: "installer-publication", "cancel-in-progress": false })
  assert.equal(publish.permissions["id-token"], "write")
  const steps = publish.steps.map((step) => step.name ?? "")
  assert.ok(steps.indexOf("Require the exact tag-bound signing identity") < steps.indexOf("Sign and self-verify the complete archive set"))
  assert.ok(steps.indexOf("Sign and self-verify the complete archive set") < steps.indexOf("Publish verified archives and update latest last"))
  assert.match(publish.steps.find((step) => step.name === "Require the exact tag-bound signing identity").run, /GITHUB_WORKFLOW_REF.*refs\/tags/)
  assert.equal(publish.steps.find((step) => step.name === "Install trusted Cosign v3").with["cosign-release"], "v3.0.2")
  assert.match(publish.steps.find((step) => step.name === "Publish verified archives and update latest last").run, /INSTALLER_FORMAT.*npm-directory-v1/)
})

test("signing requires the exact trusted GitHub tag context and all four archives", () => temp(async (root) => {
  await releaseFiles(root)
  const calls = []
  const run = (...args) => { calls.push(args); return "" }
  for (const [key, value] of Object.entries(trustedEnv)) {
    await assert.rejects(signInstallerRelease({ directory: root, tag, env: { ...trustedEnv, [key]: value + "-other" }, run }), /repository|tag|workflow|identity|GitHub|source|candidate/i)
  }
  for (const key of ["INSTALLER_SOURCE_SHA", "INSTALLER_CANDIDATE_INTEGRITY"]) {
    const env = { ...trustedEnv }
    delete env[key]
    await assert.rejects(signInstallerRelease({ directory: root, tag, env, run }), /source|candidate|identity|require/i)
  }
  assert.equal(calls.length, 0)
  await rm(join(root, archiveName(tag, "linux", "x64")))
  await assert.rejects(signInstallerRelease({ directory: root, tag, env: trustedEnv, run }), /missing|archive|four|linux/i)
  assert.equal(calls.length, 0)
}))

test("signing refuses untested, changed or inconsistent platform artifacts before cosign", () => temp(async (root) => {
  await releaseFiles(root)
  const run = () => assert.fail("invalid release must not invoke cosign")
  const archive = archiveName(tag, "linux", "x64")
  const receipt = join(root, `${archive}.json`)
  const original = await readFile(receipt, "utf8")
  await rm(receipt)
  await assert.rejects(signInstallerRelease({ directory: root, tag, env: trustedEnv, run }), /receipt|evidence|missing|ENOENT/i)
  await writeFile(receipt, original)
  await writeFile(join(root, archive), "different bytes")
  await assert.rejects(signInstallerRelease({ directory: root, tag, env: trustedEnv, run }), /sha|hash|digest|checksum|evidence|receipt/i)
  await writeFile(join(root, archive), "linux-x64\n")
  await writeFile(receipt, JSON.stringify({ ...JSON.parse(original), candidateIntegrity: integrity(Buffer.from("another candidate")) }))
  await assert.rejects(signInstallerRelease({ directory: root, tag, env: trustedEnv, run }), /candidate|evidence|integrity/i)
  await writeFile(receipt, original)
  await writeFile(join(root, "smithers-v0.9.0-linux-amd64.tar.gz"), "stale")
  await assert.rejects(signInstallerRelease({ directory: root, tag, env: trustedEnv, run }), /extra|unexpected|archive|roster/i)
}))

test("signing writes full archive filenames and signs that checksum file once", () => temp(async (root) => {
  await releaseFiles(root)
  const calls = []
  const run = (command, args) => { calls.push([command, args]); return "" }
  await signInstallerRelease({ directory: root, tag, env: trustedEnv, run })
  const checksum = await readFile(join(root, "SHA256SUMS"), "utf8")
  const lines = checksum.trim().split("\n")
  assert.equal(lines.length, 4)
  for (const [platform, arch] of targets) {
    const filename = archiveName(tag, platform, arch)
    const hash = createHash("sha256").update(await readFile(join(root, filename))).digest("hex")
    assert.ok(lines.includes(`${hash}  ${filename}`), `checksum should bind ${filename}`)
  }
  assert.equal(calls.length, 2)
  assert.equal(calls[0][0], "cosign")
  assert.deepEqual(calls[0][1], ["sign-blob", "--yes", "--bundle", "SHA256SUMS.sigstore.json", "SHA256SUMS"])
  assert.equal(calls[1][0], "cosign")
  assert.equal(calls[1][1][0], "verify-blob")
}))

test("verification pins the release workflow identity and rejects changed archive bytes", () => temp(async (root) => {
  const names = await verifiedFiles(root)
  const calls = []
  const run = (command, args) => { calls.push([command, args]); return "" }
  await verifyInstallerRelease({ directory: root, tag, run })
  const cosign = calls.find(([command]) => command === "cosign")
  assert.ok(cosign, "verification must invoke cosign")
  assert.ok(cosign[1].includes("https://token.actions.githubusercontent.com"))
  assert.ok(cosign[1].includes(`https://github.com/smithersai/smithers/.github/workflows/release.yml@refs/tags/${tag}`))
  assert.ok(cosign[1].includes("SHA256SUMS.sigstore.json"))
  await writeFile(join(root, names[0]), "tampered")
  await assert.rejects(verifyInstallerRelease({ directory: root, tag, run }), /checksum|integrity|mismatch|digest|receipt/i)
  assert.equal(calls.filter(([command]) => command === "cosign").length, 1)
}))

const verifiedFiles = async (root, releaseTag = tag) => {
  await releaseFiles(root, releaseTag)
  const names = targets.map(([platform, arch]) => archiveName(releaseTag, platform, arch)).sort()
  await writeFile(join(root, "SHA256SUMS"), (await Promise.all(names.map(async (name) =>
    `${createHash("sha256").update(await readFile(join(root, name))).digest("hex")}  ${name}`))).join("\n") + "\n")
  await writeFile(join(root, "SHA256SUMS.sigstore.json"), "{}")
  return names
}

test("publishing verifies first, refuses an occupied prefix, and writes latest last", () => temp(async (root) => {
  const stableTag = "v1.0.0"
  const names = await verifiedFiles(root, stableTag)
  const env = { INSTALLER_BUCKET: "smithers-installers", INSTALLER_S3_ENDPOINT: "https://objects.example.test" }
  const calls = []
  const run = (command, args) => {
    calls.push([command, args])
    if (args.includes("list-objects-v2")) return JSON.stringify({ KeyCount: 0 })
    if (args.includes(`s3://${env.INSTALLER_BUCKET}/latest.txt`) && args.includes("-")) return "v0.35.0\n"
    return ""
  }
  await publishInstallerRelease({ directory: root, tag: stableTag, env, run })
  assert.deepEqual(calls.slice(0, 2).map(([command]) => command), ["cosign", "aws"])
  const uploads = calls.filter(([command, args]) => command === "aws" && args.includes("cp") && !args[args.indexOf("cp") + 1].startsWith("s3://"))
  assert.deepEqual(uploads.map(([, args]) => args[args.indexOf("cp") + 1]), [
    ...names, ...names.map((name) => `${name}.json`), "SHA256SUMS", "SHA256SUMS.sigstore.json", "latest.txt"
  ])
  assert.equal(uploads.at(-1)[1].includes(`s3://${env.INSTALLER_BUCKET}/latest.txt`), true)
  assert.equal(await readFile(join(root, "latest.txt"), "utf8"), `${stableTag}\n`)
  const occupied = []
  await assert.rejects(publishInstallerRelease({ directory: root, tag: stableTag, env, run: (command, args) => {
    occupied.push([command, args])
    return args.includes("list-objects-v2") ? JSON.stringify({ KeyCount: 1 }) : ""
  } }), /exists|overwrite|prefix/i)
  assert.equal(occupied.filter(([, args]) => args.includes("cp")).length, 0)
}))

test("a failed archive upload never updates latest", () => temp(async (root) => {
  const stableTag = "v1.0.0"
  await verifiedFiles(root, stableTag)
  const calls = []
  await assert.rejects(publishInstallerRelease({ directory: root, tag: stableTag,
    env: { INSTALLER_BUCKET: "smithers-installers", INSTALLER_S3_ENDPOINT: "https://objects.example.test" },
    run: (command, args) => {
      calls.push([command, args])
      if (args.includes("list-objects-v2")) return JSON.stringify({ KeyCount: 0 })
      if (command === "aws" && args.includes("cp")) throw new Error("upload failed")
      return ""
    }
  }), /upload failed/)
  assert.equal(calls.filter(([, args]) => args.includes("cp")).length, 1)
  await assert.rejects(readFile(join(root, "latest.txt")), /ENOENT/)
}))

test("prereleases publish their version without advancing latest", () => temp(async (root) => {
  await verifiedFiles(root)
  const calls = []
  await publishInstallerRelease({ directory: root, tag,
    env: { INSTALLER_BUCKET: "smithers-installers", INSTALLER_S3_ENDPOINT: "https://objects.example.test" },
    run: (command, args) => {
      calls.push([command, args])
      return args.includes("list-objects-v2") ? JSON.stringify({ KeyCount: 0 }) : ""
    }
  })
  assert.equal(calls.filter(([, args]) => args.includes("cp") && args.includes("latest.txt")).length, 0)
  await assert.rejects(readFile(join(root, "latest.txt")), /ENOENT/)
}))

test("an older stable release cannot replace a newer latest", () => temp(async (root) => {
  const stableTag = "v1.0.0"
  await verifiedFiles(root, stableTag)
  const calls = []
  await publishInstallerRelease({ directory: root, tag: stableTag,
    env: { INSTALLER_BUCKET: "smithers-installers", INSTALLER_S3_ENDPOINT: "https://objects.example.test" },
    run: (command, args) => {
      calls.push([command, args])
      if (args.includes("list-objects-v2")) return JSON.stringify({ KeyCount: 0 })
      if (args.includes("s3://smithers-installers/latest.txt") && args.includes("-")) return "v2.0.0\n"
      return ""
    }
  })
  assert.equal(calls.filter(([, args]) => args.includes("cp") && args.includes("latest.txt") && !args.includes("-")).length, 0)
  await assert.rejects(readFile(join(root, "latest.txt")), /ENOENT/)
}))

test("first stable release publishes latest when the marker is absent with S3 404", () => temp(async (root) => {
  const stableTag = "v1.0.0"
  await verifiedFiles(root, stableTag)
  const calls = []
  await publishInstallerRelease({ directory: root, tag: stableTag,
    env: { INSTALLER_BUCKET: "smithers-installers", INSTALLER_S3_ENDPOINT: "https://objects.example.test" },
    run: (command, args) => {
      calls.push([command, args])
      if (args.includes("list-objects-v2")) return JSON.stringify({ KeyCount: 0 })
      if (args.includes("s3://smithers-installers/latest.txt") && args.includes("-")) {
        const error = new Error("missing latest")
        error.stderr = "An error occurred (404) when calling the HeadObject operation"
        throw error
      }
      return ""
    }
  })
  assert.equal(await readFile(join(root, "latest.txt"), "utf8"), `${stableTag}\n`)
  assert.equal(calls.at(-1)[1].includes("latest.txt"), true)
}))

test("latest read errors, malformed tags and prerelease markers stop stable promotion", () => temp(async (root) => {
  const stableTag = "v1.0.0"
  await verifiedFiles(root, stableTag)
  for (const previous of ["error", "not-a-tag", "v2.0.0-rc.1"]) {
    const calls = []
    await assert.rejects(publishInstallerRelease({ directory: root, tag: stableTag,
      env: { INSTALLER_BUCKET: "smithers-installers", INSTALLER_S3_ENDPOINT: "https://objects.example.test" },
      run: (command, args) => {
        calls.push([command, args])
        if (args.includes("list-objects-v2")) return JSON.stringify({ KeyCount: 0 })
        if (args.includes("s3://smithers-installers/latest.txt") && args.includes("-")) {
          if (previous === "error") {
            const error = new Error("S3 unavailable")
            error.stderr = "An error occurred (500)"
            throw error
          }
          return `${previous}\n`
        }
        return ""
      }
    }), /S3 unavailable|Invalid installer release tag|Latest must identify a stable release/i)
    assert.equal(calls.filter(([, args]) => args.includes("cp") && args.includes("latest.txt")).length, 0)
    await assert.rejects(readFile(join(root, "latest.txt")), /ENOENT/)
  }
}))

test("publishing an equal stable tag leaves latest untouched", () => temp(async (root) => {
  const stableTag = "v1.0.0"
  await verifiedFiles(root, stableTag)
  const calls = []
  await publishInstallerRelease({ directory: root, tag: stableTag,
    env: { INSTALLER_BUCKET: "smithers-installers", INSTALLER_S3_ENDPOINT: "https://objects.example.test" },
    run: (command, args) => {
      calls.push([command, args])
      if (args.includes("list-objects-v2")) return JSON.stringify({ KeyCount: 0 })
      if (args.includes("s3://smithers-installers/latest.txt") && args.includes("-")) return `${stableTag}\n`
      return ""
    }
  })
  assert.equal(calls.filter(([, args]) => args.includes("cp") && args.includes("latest.txt")).length, 0)
  await assert.rejects(readFile(join(root, "latest.txt")), /ENOENT/)
}))
