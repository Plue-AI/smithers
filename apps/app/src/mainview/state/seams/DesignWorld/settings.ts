/*
 * MOCK SEAM, Settings / Members / Secrets lane (delete with ./index.ts).
 * Maps the seeded design world to the members and secrets models the
 * real seams publish, and runs the stub writes the real flows fall back to
 * while no install answers. Card files and flows import only these names.
 *
 * Real replacements: MembersSeam (`/api/members`, `members` topic), the secrets routes (§6.3).
 */
import type { MembersCard } from "@smthrs/rpc/MembersCard"
import { PlaceholderAvatarUrl } from "@smthrs/rpc/CardPrimitives"
import type { MembersSnapshot, MembersSnapshots } from "../MembersSeam"
import type { DesignMember, DesignResult, DesignSecret, DesignWorld, DesignWorldRows } from "./index"

/** A flow handler's answer: an acknowledgment, or the refusal it shows. */
export const designAnswer = (result: DesignResult): string | { readonly value: string } =>
  result.ok ? { value: result.ack } : result.refusal

export const designViewerRole = (design: DesignWorld): DesignMember["role"] =>
  design.world().members.find(member => member.id === design.viewer())?.role ?? "member"

export const designObsidian = (world: DesignWorldRows): { readonly path: string } | undefined =>
  world.repo.setup.obsidian === "" ? undefined : { path: world.repo.setup.obsidian }

const membersModel = (world: DesignWorldRows): MembersCard => ({
  members: world.members.map(member => ({
    login: member.login, name: member.name, avatar_url: PlaceholderAvatarUrl, color_index: member.lane,
    role: member.role, needs_access: member.needsAccess === true, suspended: member.suspended === true, actions: []
  })) as MembersCard["members"],
  access_url: `https://github.com/${world.repo.repo}/settings/access`
})

/** The seeded roster as the members seam's external store. */
export const designMembersRoster = (design: DesignWorld): MembersSnapshots => {
  let version = -1
  let snapshot: MembersSnapshot = {}
  return {
    subscribe: design.subscribe,
    get: () => {
      if (version !== design.version()) { version = design.version(); snapshot = { model: membersModel(design.world()) } }
      return snapshot
    }
  }
}

const idOf = (design: DesignWorld, login: string): string | undefined =>
  design.world().members.find(member => member.login === login)?.id

/** Stub writes behind the members.* flows (MembersSeam is not instantiated yet). */
export const designMembers = (design: DesignWorld) => ({
  add: (login: string, role: "maintainer" | "member" | undefined) =>
    designAnswer(design.addMember(login.trim(), role === "maintainer" ? "maintain" : "write")),
  role: (login: string, role: "maintainer" | "member") => {
    const id = idOf(design, login)
    return id === undefined ? "No such member" : designAnswer(design.setRole(id, role))
  },
  remove: (login: string) => {
    const id = idOf(design, login)
    return id === undefined ? "No such member" : designAnswer(design.removeMember(id))
  }
})

export const designSecrets = (design: DesignWorld) => ({
  rows: (): ReadonlyArray<DesignSecret> => design.world().secrets,
  set: (name: string, scope: DesignSecret["scope"]) => designAnswer(design.setSecret(name, scope)),
  remove: (name: string) => designAnswer(design.deleteSecret(name))
})
