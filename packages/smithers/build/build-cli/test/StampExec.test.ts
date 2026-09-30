/**
 * Late stamp substitution. The module had no test file of its own: its only
 * exercise was one `S.Stamp.version` line inside the Go execution suite, and
 * all three defects below shipped behind that gap.
 */
import * as Stamp from "@smthrs/targets/Stamp"
import * as ChildProcess from "node:child_process"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as StampExec from "../src/StampExec.ts"

let root: string

const git = (...args: ReadonlyArray<string>): void => {
  ChildProcess.execFileSync("git", args, { cwd: root, stdio: "ignore" })
}

beforeEach(async () => {
  root = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-stamp-")))
  git("init", "-q")
  git("config", "user.email", "stamp@example.invalid")
  git("config", "user.name", "Stamp")
  git("config", "commit.gpgsign", "false")
  await Fs.writeFile(NodePath.join(root, "file.txt"), "one", "utf8")
  git("add", "-A")
  git("commit", "-qm", "one")
})

afterEach(async () => {
  await Fs.rm(root, { recursive: true, force: true }).catch(() => {})
})

describe("resolveArgv", () => {
  it("resolves every declared stamp name against the repository", async () => {
    const argv = await StampExec.resolveArgv(root, [
      StampExec.token("version", Stamp.version),
      StampExec.token("commit", Stamp.commit),
      StampExec.token("commitDate", Stamp.commitDate),
      StampExec.token("buildTime", Stamp.buildTime),
      StampExec.token("versionMeta", Stamp.versionMeta)
    ])
    const head = ChildProcess.execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim()
    expect(argv[0]).toMatch(/^[0-9a-f]{7,}$/)
    expect(argv[1]).toBe(head)
    expect(argv[2]).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(argv[3]).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    // No tag points at HEAD, so the untagged marker is the answer.
    expect(argv[4]).toBe("dev")
  })

  it("passes a literal value through and leaves unrelated argv untouched", async () => {
    const argv = await StampExec.resolveArgv(root, ["--flag", `-X=${StampExec.token("literal", "1.2.3")}`])
    expect(argv).toEqual(["--flag", "-X=1.2.3"])
  })

  /**
   * `Stamp.Value` restricts the name to five literals, but `resolveArgv`
   * decodes the payload from a token rather than through the schema. The
   * unknown arm used to return empty text, so adding a sixth stamp without
   * touching this module would have stamped every produced binary with
   * nothing.
   */
  it("fails on a stamp name it does not know rather than stamping empty text", async () => {
    const token = Stamp.token("future", { _tag: "Stamp", name: "future" })
    await expect(StampExec.resolveArgv(root, [token])).rejects.toThrow(/unknown build stamp: "future"/)
  })

  /**
   * `Buffer.from(..., "base64url")` never throws: it drops the characters it
   * cannot read. A corrupt token therefore reached `JSON.parse` and left a raw
   * V8 `SyntaxError` carrying the decoded garbage.
   */
  it("names the argument holding a corrupt token", async () => {
    await expect(StampExec.resolveArgv(root, ["-X={smthrs:stamp:not-base64-json}"]))
      .rejects.toThrow(/invalid build stamp token in "-X=\{smthrs:stamp:not-base64-json\}"/)
  })

  /**
   * `String.prototype.replace` with a string replacement expands `$&`, `$1`,
   * and friends. `$` is a legal git refname character, so a tag such as
   * `v1.0-$&` used to be expanded into the argv instead of inserted.
   */
  it("inserts a stamped value carrying a dollar sequence literally", async () => {
    git("tag", "v1.0-$&")
    const argv = await StampExec.resolveArgv(root, [`-X=${StampExec.token("version", Stamp.version)}`])
    expect(argv[0]).toBe("-X=v1.0-$&")
  })

  it("refuses a payload that is neither a literal nor a public stamp", async () => {
    const token = Stamp.token("bogus", { _tag: "NotAStamp" })
    await expect(StampExec.resolveArgv(root, [token])).rejects.toThrow(/only public stamps and literals/)
  })
})

describe("pinning stamps for an approved revision", () => {
  it("finds each distinct token once, in first-seen order", () => {
    const commit = StampExec.token("commit", Stamp.commit)
    const version = StampExec.token("version", Stamp.version)
    expect(StampExec.tokensIn([`a:${commit}`, `${version}-${commit}`, "plain"])).toEqual([commit, version])
    expect(StampExec.tokensIn(["plain", ""])).toEqual([])
  })

  it("names the public stamp a token carries, and nothing for literals or corrupt tokens", () => {
    expect(StampExec.nameOf(StampExec.token("docker-tag", Stamp.buildTime))).toBe("buildTime")
    expect(StampExec.nameOf(StampExec.token("commit", Stamp.commit))).toBe("commit")
    expect(StampExec.nameOf(StampExec.token("literal", "1.2.3"))).toBeUndefined()
    expect(StampExec.nameOf("{smthrs:stamp:not-base64-json}")).toBeUndefined()
    expect(StampExec.nameOf(`{smthrs:stamp:${Buffer.from("null").toString("base64url")}}`)).toBeUndefined()
  })

  it("resolves tokens now and substitutes them, leaving unknown tokens alone", async () => {
    const commit = StampExec.token("commit", Stamp.commit)
    const other = StampExec.token("version", Stamp.version)
    const values = await StampExec.resolveTokens(root, [commit])
    const head = ChildProcess.execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim()
    expect([...values]).toEqual([[commit, head]])
    expect(StampExec.substitute(`reg/app:${commit}`, values)).toBe(`reg/app:${head}`)
    expect(StampExec.substitute(`${other}`, values)).toBe(other)
    expect(StampExec.substitute(`$&${commit}`, new Map([[commit, "$1"]]))).toBe("$&$1")
  })
})
