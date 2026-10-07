import { expect, test } from "bun:test"
import controls from "./fixtures/AppendixB4.json"
import { generateCatalog } from "../../../../../scripts/catalog-mvp"
import { baseFlows, type CommandActions } from "./Flows"
import { repositoryFlowLeaves } from "./entries/flow"
import { disclosedToAgent, nameOf, visible } from "./registry"

// Reviewed B.4 expansions; expectations are independent of generated metadata.
test("every in-card control has one descriptor and exactly its person/agent policy", () => {
  const rows = generateCatalog()
  for (const expected of controls) {
    const matches = rows.filter(row => row.name === expected.name)
    expect(matches, expected.name).toHaveLength(1)
    expect(matches[0], expected.name).toMatchObject(expected)
  }
})

test("repository metadata adds one door to each human and app-agent projection", () => {
  const actions = new Proxy({ docsAvailable: () => true, debugApi: { available: () => true } }, {
    get: (target, key) => Reflect.get(target, key) ?? (() => undefined)
  }) as unknown as CommandActions
  const original = baseFlows(actions)
  const leaves = repositoryFlowLeaves(actions, "smithersai/smithers", ["release-notes", "lint-fix"].map(id => ({
    id, description: `Run ${id}`, summary: `Run ${id}`, featured: false, model: null, modelInvocable: true
  })))
  const human = (entries: typeof original) => visible(entries.map(entry => ({ name: nameOf(entry), ...entry.metadata }))).map(row => row.name)
  const agent = (entries: typeof original) => entries.filter(entry => disclosedToAgent(entry.metadata)).map(nameOf)
  for (const project of [human, agent]) {
    const before = new Set(project(original)), after = project([...original, ...leaves])
    expect(after.filter(name => !before.has(name)).sort()).toEqual(["lint-fix", "release-notes"])
    for (const name of ["lint-fix", "release-notes"]) expect(after.filter(actual => actual === name)).toHaveLength(1)
  }
  expect(leaves.map(entry => entry.metadata.agent)).toEqual(["run", "run"])
})
