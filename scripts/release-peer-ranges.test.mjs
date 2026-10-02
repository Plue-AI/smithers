import assert from "node:assert/strict"
import test from "node:test"
import { peerRangesOf } from "./release-peer-ranges.mjs"

test("release consumers satisfy all peer contracts, including union ranges", () => {
  const peers = peerRangesOf([
    { peerDependencies: { vitest: "^4.1.9 || ^5.0.0", effect: "4.0.0-rc.115", "@smthrs/flow": "workspace:*" } },
    { peerDependencies: { vitest: "4.1.9", effect: "4.0.0-rc.115" } },
    {}
  ])
  assert.equal(peers.get("vitest"), "^4.1.9 4.1.9 || ^5.0.0 4.1.9")
  assert.equal(peers.get("effect"), "4.0.0-rc.115")
  assert.equal(peers.has("@smthrs/flow"), false)
})

test("minimal consumers select only required peers and explicitly requested optional adapters", () => {
  const manifests = [{ peerDependencies: { effect: "4.0.0-rc.115", node: "1", browser: "2" },
    peerDependenciesMeta: { node: { optional: true }, browser: { optional: true } } }]
  assert.deepEqual([...peerRangesOf(manifests, { optionalPeers: [] })], [["effect", "4.0.0-rc.115"]])
  assert.deepEqual([...peerRangesOf(manifests, { optionalPeers: ["node"] })], [["effect", "4.0.0-rc.115"], ["node", "1"]])
  assert.equal(peerRangesOf(manifests).get("browser"), "2")
})

test("selected first-party peers retain their exact release contracts", () => {
  const manifests = [{ peerDependencies: { "@smthrs/platform-node": "1.0.0-rc.0", "@smthrs/testing": "1.0.0-rc.0" },
    peerDependenciesMeta: { "@smthrs/testing": { optional: true } } }]
  assert.deepEqual([...peerRangesOf(manifests, { optionalPeers: [], includeFirstParty: true })], [["@smthrs/platform-node", "1.0.0-rc.0"]])
  assert.deepEqual([...peerRangesOf(manifests, { optionalPeers: ["@smthrs/testing"], includeFirstParty: true })],
    [["@smthrs/platform-node", "1.0.0-rc.0"], ["@smthrs/testing", "1.0.0-rc.0"]])
})

test("an executable selects an optional adapter and all selected consumers constrain its range", () => {
  const library = { peerDependencies: { sqlite: "^1", vitest: "^4.1.9 || ^5.0.0" },
    peerDependenciesMeta: { sqlite: { optional: true }, vitest: { optional: true } } }
  for (const executable of [{ dependencies: { sqlite: "1.2.0" } }, { peerDependencies: { sqlite: "1.2.0" } }]) {
    const peers = peerRangesOf([library, executable], { optionalPeers: [] })
    assert.equal(peers.has("sqlite"), true)
    assert.equal(peers.has("vitest"), false)
  }
  assert.equal(peerRangesOf([library, { peerDependencies: { vitest: "4.1.9" } }], { optionalPeers: [] }).get("vitest"),
    "^4.1.9 4.1.9 || ^5.0.0 4.1.9")
})

test("an explicitly installed first-party facade selects its optional peer contract", () => {
  const manifests = [
    { name: "@smthrs/recording-fixture", peerDependencies: { "@smthrs/testing": "1.0.0-rc.0" },
      peerDependenciesMeta: { "@smthrs/testing": { optional: true } } },
    { name: "@smthrs/testing", version: "1.0.0-rc.0" }
  ]
  assert.deepEqual([...peerRangesOf(manifests, { optionalPeers: [], includeFirstParty: true })],
    [["@smthrs/testing", "1.0.0-rc.0"]])
})

test("peer selection preserves single-use manifest iterators", () => {
  const manifests = new Map([
    ["library", { peerDependencies: { effect: "4.0.0-rc.115", sqlite: "1" },
      peerDependenciesMeta: { sqlite: { optional: true } } }],
    ["cli", { dependencies: { sqlite: "1" } }]
  ])
  assert.deepEqual([...peerRangesOf(manifests.values(), { optionalPeers: [] })],
    [["effect", "4.0.0-rc.115"], ["sqlite", "1"]])
})
