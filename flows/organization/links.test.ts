/**
 * The linker over a real wiki checkout with a local bare upstream and a real
 * repository: pages link to the wiki's web address under their name, only
 * when they exist and the upstream holds them; a new page is committed and
 * pushed before the text that names it is returned; issues, pull requests,
 * commits and branches link to GitHub when the remote holds them; nothing in
 * a code span is linked; Slack's three characters are escaped; the wiki gets
 * wikilinks.
 */
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"
import * as Links from "./links.ts"

const scratch = mkdtempSync(join(tmpdir(), "org-links-"))
after(() => rmSync(scratch, { recursive: true, force: true }))

const git = (cwd: string, ...args: ReadonlyArray<string>) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()

let serial = 0
const checkout = (files: Readonly<Record<string, string>>) => {
  const base = join(scratch, String(++serial))
  const bare = join(base, "remote.git")
  const work = join(base, "work")
  mkdirSync(work, { recursive: true })
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare])
  git(work, "init", "-q", "-b", "main")
  git(work, "config", "user.name", "Fixture")
  git(work, "config", "user.email", "fixture@example.invalid")
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(work, path, ".."), { recursive: true })
    writeFileSync(join(work, path), text)
  }
  git(work, "add", ".")
  git(work, "commit", "-qm", "init")
  git(work, "remote", "add", "origin", bare)
  git(work, "push", "-q", "-u", "origin", "main")
  return { work, bare, state: join(base, "state") }
}

const wikiLinker = (wiki: ReturnType<typeof checkout>, publish?: ReadonlyArray<string>, repositories: Links.Options["repositories"] = {}) => {
  mkdirSync(wiki.state, { recursive: true })
  return Links.make({
    root: wiki.work,
    stateDir: wiki.state,
    generatedDir: "Org/Runs",
    webUrl: "https://github.com/acme/wiki/blob/main",
    publish,
    repositories
  })
}

const web = (path: string) => `https://github.com/acme/wiki/blob/main/${path}`

test("derives the web address from a GitHub remote", () => {
  assert.equal(Links.webUrlOf("git@github.com:smithersai/Smithers-Ops.git", "main"), "https://github.com/smithersai/Smithers-Ops/blob/main")
  assert.equal(Links.webUrlOf("https://github.com/acme/wiki", "release/1"), "https://github.com/acme/wiki/blob/release/1")
  assert.equal(Links.webUrlOf("ssh://git@github.com/acme/wiki.git", "main"), "https://github.com/acme/wiki/blob/main")
  assert.equal(Links.webUrlOf("/tmp/remote.git", "main"), undefined)
})

test("derives it from the wiki's own upstream when the page gives none", () => {
  const wiki = checkout({ "Org/Status.md": "# Status\n" })
  git(wiki.work, "remote", "set-url", "--push", "origin", wiki.bare)
  git(wiki.work, "config", "remote.origin.url", "git@github.com:acme/Wiki.git")
  const linker = Links.make({ root: wiki.work, stateDir: wiki.state, generatedDir: "Org/Runs", repositories: {} })
  // The upstream-tracking ref still names the pushed page.
  assert.equal(linker.slack("See Org/Status.md"), "See <https://github.com/acme/Wiki/blob/main/Org/Status.md|Status>")
})

test("links a page under its name, and names a path that does not exist as it is", () => {
  const wiki = checkout({ "Org/Proposals/2026-09-26-security-vm-cancel.md": "# P\n", "Areas/Deploy Notes.md": "# D\n" })
  const linker = wikiLinker(wiki)
  assert.equal(
    linker.slack("Commented on 2026-09-26-security-vm-cancel", [{ kind: "page", path: "Org/Proposals/2026-09-26-security-vm-cancel.md" }]),
    `Commented on <${web("Org/Proposals/2026-09-26-security-vm-cancel.md")}|2026-09-26-security-vm-cancel>`
  )
  assert.equal(
    linker.slack("Read Org/Proposals/2026-09-26-security-vm-cancel.md, then Org/Missing.md."),
    `Read <${web("Org/Proposals/2026-09-26-security-vm-cancel.md")}|2026-09-26-security-vm-cancel>, then Org/Missing.md.`
  )
  // A typed page is appended when the text does not name it; a space is encoded.
  assert.equal(
    linker.slack("Notes", [{ kind: "page", path: "Areas/Deploy Notes.md" }]),
    `Notes · <${web("Areas/Deploy%20Notes.md")}|Deploy Notes>`
  )
  assert.equal(linker.slack("Gone", [{ kind: "page", path: "Org/Missing.md" }]), "Gone · Org/Missing.md")
  // Never in code, and Slack's characters are escaped around the link.
  assert.equal(
    linker.slack("`Org/Proposals/2026-09-26-security-vm-cancel.md` <b> & a"),
    "`Org/Proposals/2026-09-26-security-vm-cancel.md` &lt;b&gt; &amp; a"
  )
  // The wiki gets wikilinks.
  assert.equal(
    linker.wiki("Proposal", [{ kind: "page", path: "Org/Proposals/2026-09-26-security-vm-cancel.md" }]),
    "Proposal · [[Org/Proposals/2026-09-26-security-vm-cancel|2026-09-26-security-vm-cancel]]"
  )
  assert.equal(linker.wiki("See Areas/Deploy Notes.md or Org/Missing.md"), "See Areas/Deploy Notes.md or Org/Missing.md")
})

test("pushes a new page before the text naming it is returned, and labels a receipt", () => {
  const wiki = checkout({ "Org/README.md": "# Org\n" })
  const linker = wikiLinker(wiki, ["Org/Runs", "Org/Team"])
  mkdirSync(join(wiki.work, "Org/Runs/slack-T1-Ev1"), { recursive: true })
  writeFileSync(join(wiki.work, "Org/Runs/slack-T1-Ev1/deliver.json"), "{}\n")
  assert.throws(() => git(wiki.bare, "cat-file", "-e", "main:Org/Runs/slack-T1-Ev1/deliver.json"))
  const text = linker.slack("Landed", [{ kind: "page", path: "Org/Runs/slack-T1-Ev1/deliver.json" }])
  assert.equal(text, `Landed · <${web("Org/Runs/slack-T1-Ev1/deliver.json")}|receipt>`)
  git(wiki.bare, "cat-file", "-e", "main:Org/Runs/slack-T1-Ev1/deliver.json")
  // A page edited since is pushed again before it is linked.
  writeFileSync(join(wiki.work, "Org/Runs/slack-T1-Ev1/deliver.json"), "{\"v\":2}\n")
  linker.slack("Again Org/Runs/slack-T1-Ev1/deliver.json")
  assert.equal(git(wiki.bare, "show", "main:Org/Runs/slack-T1-Ev1/deliver.json"), "{\"v\":2}")
})

test("leaves a page the host does not push unlinked, and links one whose push failed", () => {
  const wiki = checkout({ "Org/README.md": "# Org\n" })
  writeFileSync(join(wiki.work, "Org/Draft.md"), "# Draft\n")
  // Not a host path: never committed, so never linked.
  assert.equal(wikiLinker(wiki, ["Org/Runs"]).slack("See Org/Draft.md"), "See Org/Draft.md")
  // A host that does not sync links only what its upstream holds.
  mkdirSync(join(wiki.work, "Org/Runs"), { recursive: true })
  writeFileSync(join(wiki.work, "Org/Runs/a.md"), "# A\n")
  assert.equal(wikiLinker(wiki).slack("See Org/Runs/a.md"), "See Org/Runs/a.md")
  // The push fails: the post goes out with the link anyway.
  git(wiki.work, "remote", "set-url", "origin", join(wiki.bare, "gone"))
  assert.equal(wikiLinker(wiki, ["Org/Runs"]).slack("See Org/Runs/a.md"), `See <${web("Org/Runs/a.md")}|a>`)
})

test("links issues, pull requests, commits and branches of configured repositories", () => {
  const wiki = checkout({ "Org/README.md": "# Org\n" })
  const repo = checkout({ "README.md": "# Demo\n" })
  git(repo.work, "checkout", "-q", "-b", "organization/pushed")
  writeFileSync(join(repo.work, "a.txt"), "a\n")
  git(repo.work, "add", ".")
  git(repo.work, "commit", "-qm", "a")
  git(repo.work, "push", "-q", "origin", "organization/pushed")
  const pushed = git(repo.work, "rev-parse", "HEAD")
  git(repo.work, "checkout", "-q", "-b", "organization/local")
  writeFileSync(join(repo.work, "b.txt"), "b\n")
  git(repo.work, "add", ".")
  git(repo.work, "commit", "-qm", "b")
  const local = git(repo.work, "rev-parse", "HEAD")
  const linker = wikiLinker(wiki, undefined, { "acme/demo": { path: repo.work, github: "acme/demo" } })
  assert.equal(
    linker.slack("Fixes #12 and acme/demo#3, not other/x#4 or a#b."),
    "Fixes <https://github.com/acme/demo/issues/12|#12> and <https://github.com/acme/demo/issues/3|#3>, not other/x#4 or a#b."
  )
  assert.equal(
    linker.slack("PR https://github.com/acme/demo/pull/7 and https://example.com/?a=1&b=2"),
    "PR <https://github.com/acme/demo/pull/7|#7> and https://example.com/?a=1&amp;b=2"
  )
  assert.equal(
    linker.slack(`Landed on organization/pushed ${pushed.slice(0, 12)}`),
    `Landed on <https://github.com/acme/demo/tree/organization/pushed|organization/pushed> <https://github.com/acme/demo/commit/${pushed}|${pushed.slice(0, 12)}>`
  )
  assert.equal(
    linker.slack("Landed on", [
      { kind: "branch", repository: "acme/demo", branch: "organization/local" },
      { kind: "commit", repository: "acme/demo", sha: local }
    ]),
    `Landed on · \`organization/local\` · \`${local.slice(0, 12)}\``
  )
  assert.equal(
    linker.slack(`Landed on organization/local ${local.slice(0, 12)}`, [
      { kind: "branch", repository: "acme/demo", branch: "organization/local" },
      { kind: "commit", repository: "acme/demo", sha: local }
    ]),
    `Landed on \`organization/local\` \`${local.slice(0, 12)}\``
  )
  assert.equal(
    linker.slack("Opened", [{ kind: "pull", github: "acme/demo", number: 9, url: "https://github.com/acme/demo/pull/9" }]),
    "Opened · <https://github.com/acme/demo/pull/9|#9>"
  )
  // Hex that is no commit here, and a plain number, stay text.
  assert.equal(linker.slack("deadbeefcafe 1234567"), "deadbeefcafe 1234567")
  assert.equal(Links.none.slack("a", [{ kind: "page", path: "Org/x.md" }]), "a · Org/x.md")
  assert.deepEqual(Links.refOf("https://x.test/a"), { kind: "url", url: "https://x.test/a" })
  assert.deepEqual(Links.refOf("Org/x.md"), { kind: "page", path: "Org/x.md" })
})
