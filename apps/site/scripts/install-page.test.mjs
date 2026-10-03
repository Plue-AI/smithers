/** Check the install instructions against the checked-out CLI, never a PATH binary. */
import assert from "node:assert/strict"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"

const site = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const root = resolve(site, "../..")
const read = (path) => readFileSync(join(root, path), "utf8")
const installation = read("apps/site/docs/installation.mdx")

// Remove each exception when its command ships. These are engineering tickets,
// not an open-ended exemption for commands absent from an installed release.
const planned = new Map([
  ["smthrs host start", ["T-INS-08"]],
  ["smthrs host start --bind 0.0.0.0 --origin http://studio-mini.local:4000", ["T-INS-08", "T-INS-04"]]
])

const snippets = (text) => [...text.matchAll(/```(?:bash|sh|shell)\s*\n([\s\S]*?)```|`(smthrs [^`\n]+)`/g)].flatMap((match) => {
  const preceding = text.slice(0, match.index)
  const section = preceding.slice(preceding.lastIndexOf("\n## "))
  return (match[1] ?? match[2]).split("\n").filter((line) => /^smthrs\s/.test(line.trim())).map((line) => ({ command: line.trim(), section }))
})

function validateCommands(text, commands) {
  const seen = new Set()
  for (const { command, section } of snippets(text)) {
    const words = command.split(/\s+/).slice(1)
    const name = words.slice(0, words.findIndex((word) => word.startsWith("--")) < 0 ? words.length : words.findIndex((word) => word.startsWith("--"))).join(" ")
    const shipped = commands.find((entry) => entry.name === name)
    const tickets = planned.get(command)
    if (tickets) {
      assert.equal(shipped, undefined, `${name} now ships; remove its planned exception and update installation`)
      assert.match(section, /\*\*Planned\.\*\*/, `${command} must be explicitly planned in its section`)
      for (const ticket of tickets) assert.ok(existsSync(join(root, `.specs/engineering/tickets/${ticket}.md`)), `${ticket} must exist`)
      seen.add(command)
      continue
    }
    assert.ok(shipped, `undocumented exception: ${command} does not ship`)
    for (const word of words.filter((word) => word.startsWith("--"))) {
      const option = word.slice(2).split("=")[0]
      assert.ok(shipped.schema?.options?.properties?.[option], `${name} has no --${option}`)
    }
  }
  return seen
}

test("install commands exist in the source CLI or have an expiring planned exception", async () => {
  const { installEffectResolution } = await import(join(root, "packages/smithers/build/build-cli/src/effect-resolution.js"))
  installEffectResolution()
  const { makeCli } = await import(join(root, "packages/smithers/src/Cli.ts"))
  const cli = makeCli({ environment: { ...process.env, NO_COLOR: "1" } })
  let output = ""
  let status = 0
  await cli.serve(["--llms-full", "--format", "json"], {
    stdout: (text) => { output += text },
    exit: (code) => { status = code }
  })
  assert.equal(status, 0, output)
  const { commands } = JSON.parse(output)
  assert.ok(Array.isArray(commands) && commands.length > 0, "source CLI must return a command manifest")
  assert.deepEqual([...validateCommands(installation, commands)], [...planned.keys()])
})

test("planned command guard rejects new commands, missing labels and shipped exceptions", () => {
  assert.throws(() => validateCommands("## Start\n```bash\nsmthrs invented\n```", []), /does not ship/)
  assert.throws(() => validateCommands("## Start\n```bash\nsmthrs host start\n```", []), /explicitly planned/)
  assert.throws(() => validateCommands("## Start\n**Planned.**\n```bash\nsmthrs host start\n```", [{ name: "host start" }]), /now ships/)
  assert.throws(() => validateCommands("```bash\nsmthrs doctor --invented\n```", [{ name: "doctor", schema: { options: { properties: {} } } }]), /has no --invented/)
  assert.equal(validateCommands("```bash\nsmthrs doctor --verbose\n```", [{ name: "doctor", schema: { options: { properties: { verbose: {} } } } }]).size, 0)
})

test("the public sidebar contains only installation and the API", () => {
  const config = read("apps/site/astro.config.mjs")
  const sidebar = config.match(/sidebar:\s*\[([\s\S]*?)\]/)?.[1]
  assert.ok(sidebar, "explicit public sidebar must exist")
  assert.deepEqual([...sidebar.matchAll(/slug:\s*["']([^"']+)["']/g)].map((match) => match[1]), ["docs/installation", "docs/reference/http-api"])
  assert.doesNotMatch(sidebar, /autogenerate|items:/)
})

test("installation keeps the project opening", () => {
  const { description } = JSON.parse(read("apps/site/src/data/project.json"))
  const opening = installation.split("{/* generated:project-description end */}")[0].split("*/}")[1]?.trim()
  assert.equal(opening, description)

})

// Frozen retirement inventory for #3458; installation is the replacement page.
test("every retired inventory path is absent", () => {
  const retired = JSON.parse(read("apps/site/docs/retired-pages.json"))
  assert.equal(retired.length, 53)
  assert.equal(new Set(retired).size, retired.length)
  for (const path of retired) assert.equal(existsSync(join(root, path)), false, `retired page exists: ${path}`)
})

test("the planned Homebrew action stays tied to its release ticket", () => {
  const section = installation.split("## Install\n")[1]?.split("\n## ")[0]
  assert.match(section, /\*\*Planned\.\*\*/)
  assert.match(section, /brew install smithersai\/tap\/smithers/)
  assert.match(read(".specs/engineering/tickets/T-INS-05.md"), /smithersai\/homebrew-tap/)
})

test("the site has no empty documentation pages", () => {
  const content = join(site, "src/content/docs")
  for (const path of readdirSync(content, { recursive: true }).filter(path => /\.mdx?$/.test(path))) {
    assert.ok(readFileSync(join(content, path), "utf8").trim().length > 0, `empty documentation page: ${path}`)
  }
})

test("planned setup puts Address and App before the owner claim and repository", () => {
  const section = installation.split("## Complete setup\n")[1]?.split("\n## ")[0]
  assert.ok(section, "setup section must exist")
  assert.match(section, /\*\*Planned\.\*\*/)
  assert.deepEqual([...section.matchAll(/^\d+\. \*\*([^*]+)\*\*/gm)].map(match => match[1]),
    ["Address:", "GitHub App:", "Owner sign-in:", "Repository:", "Model access:"])
  for (const claim of [/This Mac/, /network address/, /callback is registered/, /through the new App/,
    /squash merging/, /retry/, /\*\*fast\*\*/, /\*\*coding\*\*/, /\*\*Decisions\*\*/,
    /provider key or ChatGPT sign-in/, /AI Gateway key/, /Without a fast-model key/]) assert.match(section, claim)
  assert.doesNotMatch(section, /\bjev\b/i)
})
