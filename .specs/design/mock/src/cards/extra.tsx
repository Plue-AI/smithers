/* Cards the later journeys add (issue, flow, answer). Each registers its renderer here. */
import type { ComponentType } from "react"
import type { CardKind } from "../world"
import { DraftCard } from "./Draft"
import { FlowCard } from "./Flow"
import { IssueCard } from "./Issue"
import { ProposalCard } from "./Learning"
import { SettingsCard, SetupCard } from "./Setup"
import { ReviewCard } from "./Review"
import { ConfirmCard } from "./Confirm"
import { CommandsCard } from "./Commands"
import { MembersCard, SecretsCard } from "./People"
import { RunCard } from "./Run"
import { ActCard } from "./Act"
import { LaterCard } from "./Later"
import { FormCard } from "./Form"
import { WikiCard } from "./Wiki"
import { AgentCard } from "./Agent"

export interface ExtraCardProps {
  readonly id: string
  readonly target: string
  readonly view?: string
}

export const EXTRA_CARDS: Partial<Record<CardKind, ComponentType<ExtraCardProps>>> = {
  issue: IssueCard,
  draft: DraftCard,
  flow: FlowCard,
  proposal: ProposalCard,
  setup: SetupCard,
  settings: SettingsCard,
  review: ReviewCard,
  confirm: ConfirmCard,
  commands: CommandsCard,
  members: MembersCard,
  secrets: SecretsCard,
  run: RunCard,
  act: ActCard,
  agent: AgentCard,
  form: FormCard,
  later: LaterCard,
  wiki: WikiCard
}
