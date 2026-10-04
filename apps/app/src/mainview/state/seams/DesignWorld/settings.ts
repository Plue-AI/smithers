/*
 * MOCK SEAM, Settings / Members / Secrets lane (delete with ./index.ts).
 * Maps the seeded design world to the install, members and secrets models the
 * real seams publish, and runs the stub writes the real flows fall back to
 * while no install answers. Card files and flows import only these names.
 *
 * Real replacements: InstallSeam (`/api/install`, settings.* flows),
 * MembersSeam (`/api/members`, `members` topic), the secrets routes (§6.3).
 */
import { createCollection, localOnlyCollectionOptions } from "@tanstack/db"
import type { MembersCard } from "@smthrs/rpc/MembersCard"
import { PlaceholderAvatarUrl } from "@smthrs/rpc/CardPrimitives"
import type { InstallModel } from "../InstallModel"
import type { InstallAddress, InstallSnapshot, InstallSnapshots } from "../InstallSeam"
import type { MembersSnapshot, MembersSnapshots } from "../MembersSeam"
import type { ActorId, DesignMember, DesignResult, DesignSecret, DesignWorld, DesignWorldRows } from "./index"

/** A flow handler's answer: an acknowledgment, or the refusal it shows. */
export const designAnswer = (result: DesignResult): string | { readonly value: string } =>
  result.ok ? { value: result.ack } : result.refusal

export const designViewerRole = (design: DesignWorld): DesignMember["role"] =>
  design.world().members.find(member => member.id === design.viewer())?.role ?? "member"

const keyState = (state: "validating" | "saved" | "failed" | undefined) => state ?? "none"

/** The seeded install as the install seam's model. */
export const designInstallModel = (world: DesignWorldRows): InstallModel => {
  const setup = world.repo.setup
  const [owner = "acme", name = "api"] = (setup.repository ?? world.repo.repo).split("/")
  const stale = world.repo.syncedAgo > 120
  return {
    address: {
      listen: setup.listen, bind: setup.listen === "mac" ? "127.0.0.1:4000" : "0.0.0.0:4000",
      origins: setup.addresses.length > 0 ? [...setup.addresses] : ["http://localhost:4000"],
      ...(setup.addressChange === undefined ? {} : { change_failed: setup.addressChange })
    },
    steps: (["address", "app_manifest", "sign_in", "repository", "models", "source", "machine"] as const).map(id => ({ id, state: "done" as const })),
    this_mac: { memory_gb: Number.parseInt(setup.memory, 10) || 32, disk_free_gb: 400, capacity: Math.max(world.repo.capacity, 6) },
    github: { owner, signed_in: true, app_installed: setup.github === "app-installed", squash_allowed: setup.squash ?? true,
      ...(setup.appError === undefined ? {} : { app_error: setup.appError }) },
    repository: { owner, name }, repositories: [`${owner}/${name}`],
    models: [
      { role: "fast", provider: "Cerebras", key: keyState(setup.fastKey) },
      { role: "coding", provider: setup.provider, key: keyState(setup.codingKey), ...(setup.keyError === undefined ? {} : { error: setup.keyError }) },
      { role: "jev", provider: "AI Gateway", key: keyState(setup.gatewayKey) }
    ],
    chatgpt: false,
    capacity: world.repo.capacity,
    parallel: Math.min(world.repo.parallel, world.repo.capacity),
    health: {
      process: "ok", postgres_bytes: 48 * 1024 * 1024, disk_free_gb: 400,
      github: {
        health: world.repo.mainHealth?.state ?? (stale ? "stale" : "fresh"),
        ...(world.repo.mainHealth === undefined ? {} : { cause: world.repo.mainHealth.cause }),
        ...(world.repo.mainHealth?.retryAt === undefined ? {} : { retry_at: world.repo.mainHealth.retryAt }),
        rate_remaining: world.repo.mainHealth?.state === "limited" ? 0 : 4870, rate_limit: 5000
      }
    }
  }
}

/** The install the settings card reads: the live seam once it serves a model, else the seeded install. */
export const designInstall = (design: DesignWorld, live: InstallSnapshots): InstallSnapshots => {
  let version = -1
  let snapshot: InstallSnapshot = {}
  return {
    subscribe: listener => { const stops = [design.subscribe(listener), live.subscribe(listener)]; return () => { for (const stop of stops) stop() } },
    get: () => {
      const answered = live.get()
      if (!design.enabled || answered.model !== undefined) return answered
      if (version !== design.version()) { version = design.version(); snapshot = { model: designInstallModel(design.world()), seed: true } }
      return snapshot
    }
  }
}

/** Stub writes behind settings.address, settings.capacity and settings.parallel while no install serves a model. */
export const designSettings = (design: DesignWorld) => ({
  address: (address: InstallAddress) => designAnswer(design.setAddress(address.origins[0] ?? "", address.listen)),
  capacity: (capacity: number) => designAnswer(design.setCapacity(capacity)),
  parallel: (parallel: number) => designAnswer(design.setParallel(parallel))
})

/** The Settings card's per-member view state: the Address choice a person is looking at (`view.tab`), never shared. */
export interface DesignSettingsView { readonly id: ActorId; readonly listen: InstallAddress["listen"] }
const createSettingsViews = () => createCollection(localOnlyCollectionOptions<DesignSettingsView, ActorId>({
  id: `design-settings-${globalThis.crypto?.randomUUID?.() ?? String(Date.now())}`,
  getKey: row => row.id,
  initialData: []
}))
const settingsViews = new WeakMap<DesignWorld, ReturnType<typeof createSettingsViews>>()
export const settingsViewsOf = (design: DesignWorld) => {
  const existing = settingsViews.get(design)
  if (existing !== undefined) return existing
  const created = createSettingsViews()
  settingsViews.set(design, created)
  return created
}
/** The Settings card's onView: a `tab` of "mac" or "network" is the viewer's Address choice; other patches change nothing. */
export const setSettingsView = (design: DesignWorld, who: ActorId, patch: { readonly tab?: string }): void => {
  const listen = patch.tab
  if (listen !== "mac" && listen !== "network") return
  const views = settingsViewsOf(design)
  if (views.has(who)) views.update(who, draft => { draft.listen = listen })
  else views.insert({ id: who, listen })
}

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
