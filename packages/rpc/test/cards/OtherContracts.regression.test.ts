import { describe, expect, it } from "vitest"
import { ActorChipCardSchema } from "../../src/ActorChipCard.ts"
import { AgentCardSchema } from "../../src/AgentCard.ts"
import { BranchCardSchema } from "../../src/BranchCard.ts"
import { BranchTreeNodeCardSchema } from "../../src/BranchTreeNodeCard.ts"
import { CommandsCardSchema } from "../../src/CommandsCard.ts"
import { ContextLineCardSchema } from "../../src/ContextLineCard.ts"
import { DiffCardSchema } from "../../src/DiffCard.ts"
import { FileCardSchema } from "../../src/FileCard.ts"
import { FlowCardSchema } from "../../src/FlowCard.ts"
import { MembersCardSchema } from "../../src/MembersCard.ts"
import { ProposalCardSchema } from "../../src/ProposalCard.ts"
import { SecretsCardSchema } from "../../src/SecretsCard.ts"
import { SettingsCardSchema } from "../../src/SettingsCard.ts"
import { SetupCardSchema } from "../../src/SetupCard.ts"
import { TerminalCardSchema } from "../../src/TerminalCard.ts"
import { TimelineEntryCardSchema } from "../../src/TimelineEntryCard.ts"
import { ToastCardSchema } from "../../src/ToastCard.ts"
import { ben } from "../fixtures/_shared.ts"
import { fixtures as actorChip } from "../fixtures/ActorChip.ts"
import { fixtures as agent } from "../fixtures/Agent.ts"
import { fixtures as branch } from "../fixtures/Branch.ts"
import { fixtures as branchTreeNode } from "../fixtures/BranchTreeNode.ts"
import { fixtures as commands } from "../fixtures/Commands.ts"
import { fixtures as contextLine } from "../fixtures/ContextLine.ts"
import { fixtures as diff } from "../fixtures/Diff.ts"
import { fixtures as file } from "../fixtures/File.ts"
import { fixtures as flow } from "../fixtures/Flow.ts"
import { fixtures as members } from "../fixtures/Members.ts"
import { fixtures as proposal } from "../fixtures/Proposal.ts"
import { fixtures as secrets } from "../fixtures/Secrets.ts"
import { fixtures as settings } from "../fixtures/Settings.ts"
import { fixtures as setup } from "../fixtures/Setup.ts"
import { fixtures as terminal } from "../fixtures/Terminal.ts"
import { fixtures as timelineEntry } from "../fixtures/TimelineEntry.ts"
import { fixtures as toast } from "../fixtures/Toast.ts"

describe("reviewed card fixtures", () => {
  it.each(Object.entries(setup))("Setup: preserves the %s fixture", (_name, value) => {
    expect(SetupCardSchema.parse(value)).toEqual(value)
  })
  it.each(Object.entries(settings))("Settings: preserves the %s fixture", (_name, value) => {
    expect(SettingsCardSchema.parse(value)).toEqual(value)
  })
  it.each(Object.entries(branch))("Branch: preserves the %s fixture", (_name, value) => {
    expect(BranchCardSchema.parse(value)).toEqual(value)
  })
  it.each(Object.entries(agent))("Agent: preserves the %s fixture", (_name, value) => {
    expect(AgentCardSchema.parse(value)).toEqual(value)
  })
  it.each(Object.entries(file))("File: preserves the %s fixture", (_name, value) => {
    expect(FileCardSchema.parse(value)).toEqual(value)
  })
  it.each(Object.entries(diff))("Diff: preserves the %s fixture", (_name, value) => {
    expect(DiffCardSchema.parse(value)).toEqual(value)
  })
  it.each(Object.entries(terminal))("Terminal: preserves the %s fixture", (_name, value) => {
    expect(TerminalCardSchema.parse(value)).toEqual(value)
  })
  it.each(Object.entries(secrets))("Secrets: preserves the %s fixture", (_name, value) => {
    expect(SecretsCardSchema.parse(value)).toEqual(value)
  })
  it.each(Object.entries(flow))("Flow: preserves the %s fixture", (_name, value) => {
    expect(FlowCardSchema.parse(value)).toEqual(value)
  })
  it.each(Object.entries(proposal))("Proposal: preserves the %s fixture", (_name, value) => {
    expect(ProposalCardSchema.parse(value)).toEqual(value)
  })
  it.each(Object.entries(timelineEntry))("TimelineEntry: preserves the %s fixture", (_name, value) => {
    expect(TimelineEntryCardSchema.parse(value)).toEqual(value)
  })
  it.each(Object.entries(toast))("Toast: preserves the %s fixture", (_name, value) => {
    expect(ToastCardSchema.parse(value)).toEqual(value)
  })
  it.each(Object.entries(branchTreeNode))("BranchTreeNode: preserves the %s fixture", (_name, value) => {
    expect(BranchTreeNodeCardSchema.parse(value)).toEqual(value)
  })
  it.each(Object.entries(contextLine))("ContextLine: preserves the %s fixture", (_name, value) => {
    expect(ContextLineCardSchema.parse(value)).toEqual(value)
  })
  it.each(Object.entries(actorChip))("ActorChip: preserves the %s fixture", (_name, value) => {
    expect(ActorChipCardSchema.parse(value)).toEqual(value)
  })
  it.each(Object.entries(members))("Members: preserves the %s fixture", (_name, value) => {
    expect(MembersCardSchema.parse(value)).toEqual(value)
  })
  it.each(Object.entries(commands))("Commands: preserves the %s fixture", (_name, value) => {
    expect(CommandsCardSchema.parse(value)).toEqual(value)
  })
})

describe("frozen contract exceptions", () => {
  it("retains the jev model role", () => {
    expect(AgentCardSchema.parse({ ...agent.coding, role: "jev" }).role).toBe("jev")
  })
  it("accepts the shared bundled avatar on the member roster", () => {
    expect(
      MembersCardSchema.parse({
        access_url: "http://mac-mini.local:8080",
        members: [{
          login: "ben",
          name: "Ben",
          avatar_url: ben.avatar_url,
          role: "member",
          needs_access: false,
          suspended: false
        }]
      }).members[0]?.avatar_url
    ).toBe(ben.avatar_url)
  })
})

describe("review field behavior", () => {
  it("represents a branch waiting to rebase onto main", () => {
    expect(BranchCardSchema.parse({ ...branch.awake, rebase_pending: { onto: "main" } }).rebase_pending).toEqual({
      onto: "main"
    })
  })
  it.each(["javascript:alert(1)", "data:text/html,unsafe", "file:///etc/passwd"])(
    "rejects unsafe flow PR URL %s",
    (url) => {
      expect(
        FlowCardSchema.safeParse({
          ...flow.proposed,
          versions: [{ ...flow.proposed.versions[0], pr: { number: 3474, url } }]
        }).success
      ).toBe(false)
    }
  )
  it("keeps setup access validation independent for each frozen role", () => {
    const value = SetupCardSchema.parse(setup.error_without_fix)
    expect(value.models.fast).toEqual({ state: "saved", provider: "openai" })
    expect(value.models.coding).toEqual({ state: "saved", provider: "openai" })
    expect(value.models.jev).toEqual({ state: "failed", provider: "vercel", error: "Key rejected" })
    expect(
      SetupCardSchema.safeParse({
        ...setup.done,
        models: { ...setup.done.models, gateway: setup.done.models.jev, jev: undefined }
      }).success
    ).toBe(false)
  })
  it("retains address change failure and remaining machine minutes", () => {
    expect(SetupCardSchema.parse(setup.address_failed).address.change_failed).toEqual({
      from: "http://mac-mini.local:8080",
      to: "https://smithers.example.test",
      reason: "Address in use"
    })
    expect(SetupCardSchema.parse(setup.active).machine.minutes_left).toBe(6)
  })
  it("retains settings repair and upgrade information", () => {
    expect(SettingsCardSchema.parse(settings.failed).github.app_error).toBe("App callback URL missing")
    expect(SettingsCardSchema.parse(settings.upgrade).upgrade).toEqual({ version: "1.0.1" })
    expect(SettingsCardSchema.parse(settings.ready).members[0]).toEqual({
      login: "ben",
      name: "Ben Carter",
      role: "owner"
    })
  })
  it("keeps attribution inside delete and rename states", () => {
    expect(FileCardSchema.parse(file.gone).gone?.kind).toBe("deleted")
    const renamed = FileCardSchema.parse(file.renamed)
    expect(renamed.gone).toEqual({ kind: "renamed", by: file.renamed.gone.by, to: "flows/todo-next/flow.ts" })
    expect(renamed.branch).toBe("todo/12")
  })
  it("keeps agent prices and who changed the model", () => {
    expect(AgentCardSchema.parse(agent.changed).changed).toEqual({
      from: "gpt-6-astra",
      by: agent.changed.changed.by,
      at: "2026-10-02T17:42:00.000Z"
    })
    expect(AgentCardSchema.parse(agent.coding).available[0]).toEqual({
      model: "gpt-6.1-sol",
      price_in: 1,
      price_out: 2
    })
    expect(
      AgentCardSchema.safeParse({ ...agent.coding, available: [{ model: "sol", price_in: -1, price_out: 2 }] }).success
    ).toBe(false)
  })
  it("offers a machine image change from a terminal", () => {
    expect(TerminalCardSchema.parse(terminal.offer).offer).toBe("Add ripgrep to machine image")
    expect(TerminalCardSchema.parse(terminal.watching).viewer_is_owner).toBe(false)
  })
  it("retains the TODO created from an accepted proposal", () => {
    expect(ProposalCardSchema.parse(proposal.committed).todo).toEqual({ n: 12, title: "Keep completion receipts" })
  })
  it("rejects retired context and progress vocabularies", () => {
    expect(
      ContextLineCardSchema.safeParse({
        count: 1,
        expanded: true,
        items: [{ kind: "entry", label: "Acceptance", ref: "entry-12" }]
      }).success
    ).toBe(false)
    expect(ToastCardSchema.safeParse({ ...toast.no_action, kind: "progress" }).success).toBe(false)
    expect(
      FlowCardSchema.safeParse({ ...flow.active, versions: [{ ...flow.active.versions[0], state: "merged-syncing" }] })
        .success
    ).toBe(false)
  })
  it("distinguishes event entries and durable notification details", () => {
    expect(TimelineEntryCardSchema.parse(timelineEntry.event).kind).toBe("event")
    expect(ToastCardSchema.parse(toast.no_action).detail).toBe("Checks passed")
  })
  it("keeps a historical context revision and live branch participants", () => {
    expect(ContextLineCardSchema.parse(contextLine.collapsed).items[0]?.revision).toBe("head")
    const item = BranchTreeNodeCardSchema.parse(branchTreeNode.main).children[0]!
    expect(item.state).toBe("working")
    expect(item.present.map((actor) => actor.kind)).toEqual(["person", "agent"])
  })
})
