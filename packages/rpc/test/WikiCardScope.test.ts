import { expect, test } from "vitest"
import { CardSchema } from "../src/Cards.ts"

test("world listing entries preserve explicit space and account ownership across wire parsing", () => {
  for (const visibility of ["public", "private"] as const) {
    const source = {
      id: "index",
      kind: "world",
      title: "Wiki",
      createdAt: 1,
      ordinal: 1,
      status: "active",
      payload: {
        documents: [{
          id: "wiki:owner/repo:1",
          path: "Home.md",
          title: "Stored",
          confidence: 1,
          cloud: { repo: "owner/repo", slug: "home", revision: 1, visibility, accountLogin: "will" }
        }],
        index: { repo: "owner/repo", space: visibility, page: 1, hasNext: false }
      }
    }
    expect(CardSchema.parse(source)).toEqual(source)
    expect(
      CardSchema.safeParse({
        ...source,
        payload: {
          ...source.payload,
          documents: [{
            ...source.payload.documents[0],
            cloud: { ...source.payload.documents[0]!.cloud, visibility: "unknown" }
          }]
        }
      }).success
    ).toBe(false)
  }
})

test("legacy listing entries remain parseable without fabricated account or space provenance", () => {
  const source = {
    id: "index",
    kind: "world",
    title: "Wiki",
    createdAt: 1,
    ordinal: 1,
    status: "active",
    payload: {
      documents: [{
        id: "wiki:owner/repo:1",
        path: "Home.md",
        title: "Stored",
        confidence: 1,
        cloud: { repo: "owner/repo", slug: "home", revision: 1 }
      }]
    }
  }
  expect(CardSchema.parse(source)).toEqual(source)
})
