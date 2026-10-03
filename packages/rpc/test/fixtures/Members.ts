import type { MembersCard } from "../../src/MembersCard.ts"
import { ben, will } from "./_shared.ts"

const member = ({ login, name, avatar_url }: typeof ben) => ({ login, name, avatar_url })
const access_url = "http://mac-mini.local:8080"
export const fixtures = {
  empty: { access_url, members: [] },
  team: {
    access_url,
    members: [
      { ...member(will), role: "owner", needs_access: false, suspended: false },
      { ...member(ben), role: "maintainer", needs_access: false, suspended: false },
      {
        login: "sam",
        name: "Sam Lee",
        avatar_url: "https://avatars.githubusercontent.com/u/1?v=4",
        role: "member",
        needs_access: false,
        suspended: false
      }
    ]
  },
  needs_access: { access_url, members: [{ ...member(ben), role: "member", needs_access: true, suspended: false }] },
  suspended: { access_url, members: [{ ...member(ben), role: "member", needs_access: false, suspended: true }] },
  suspended_needs_access: {
    access_url,
    members: [{ ...member(ben), role: "maintainer", needs_access: true, suspended: true }]
  }
} satisfies Record<string, MembersCard>
