import { PlaceholderAvatarUrl } from "../../src/CardPrimitives.ts"

export const placeholder_avatar = PlaceholderAvatarUrl
export const at = "2026-10-02T17:42:00.000Z"
export const sha = "4bc79aef91d66ea28c90b706d584d3b9b48e14ea"
export const ben = {
  login: "ben",
  name: "Ben Carter",
  color_index: 0,
  avatar_url: placeholder_avatar
}
export const will = {
  login: "williamcory",
  name: "Will Cory",
  color_index: 0,
  avatar_url: placeholder_avatar
}
export const person = { kind: "person" as const, ...ben }
export const agent = { kind: "agent" as const, name: "implementer", color_index: 2, role: "coding" as const, todo: 12 }
export const system = { kind: "system" as const, color_index: 2 }
export const outside = { kind: "outside" as const, color_index: 5 }
export const issue = {
  number: 3474,
  title: "Card model contracts",
  url: "https://github.com/smithersai/smithers/issues/3474"
}
