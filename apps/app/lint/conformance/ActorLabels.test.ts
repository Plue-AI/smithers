import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { extractLiterals, sourceFiles } from "./Literals"
import { actorLabelViolations, actorSourceViolations } from "./Rules"

for (const phrase of [" via ", " for ", "'s terminal"]) {
  for (const file of ["cards/Sample.tsx", "state/seams/Sample.ts", "state/ProductActor.ts", "toast/Sample.ts"]) {
    test(`${file}: rejects ${phrase}`, () => {
      const source = 'const label = `${name}' + phrase + '${other}`'
      expect(extractLiterals(file, source).flatMap(actorLabelViolations)).toHaveLength(1)
    })
  }
}
test("actorName calls and comments pass", () => {
  expect(extractLiterals("card.ts", 'const label = actorName(actor) // for Ben').flatMap(actorLabelViolations)).toEqual([])
})
test("S1 actor adapters use the shared formatter", () => {
  const files = sourceFiles(resolve(import.meta.dir, "../../src/mainview"))
    .filter(file => !/\.(test|spec)\./.test(file) && /(?:cards\/|seams\/|adapter|toast|Actors\.ts$)/i.test(file) && !file.includes("/fixtures/"))
  expect(files.flatMap(file => actorSourceViolations(file, readFileSync(file, "utf8")))).toEqual([])
})

test("source lint covers template and concatenated actor labels without flagging ordinary copy", () => {
  for (const source of ['const label = `${actor.name} for ${member.name}`', 'const label = name + " via " + channel', 'const label = `${person.name}\'s terminal`']) {
    expect(actorSourceViolations("cards/Example.tsx", source)).toHaveLength(1)
  }
  expect(actorSourceViolations("toast/Example.ts", 'const text = "Stop for now"; const title = `Branches for ${repo}`; const label = actorName(actor)')).toEqual([])
})

test("source lint rejects complete participant labels", () => {
  for (const label of ["Smithers for Ben", "Aider for Ben", "Ben via SSH", "Ben's terminal"]) {
    expect(actorSourceViolations("cards/Example.tsx", `const label = ${JSON.stringify(label)}`)).toHaveLength(1)
  }
})
