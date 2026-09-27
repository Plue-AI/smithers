/** The steps of `register-repository`. Each writes one typed result the registration card renders. */
import { Action } from "@smthrs/flow"
import { Schema } from "effect"
import {
  AgentShare,
  Checks,
  CiEstimate,
  Cleanup,
  Clone,
  CommandRun,
  Commits,
  Contributors,
  Input,
  Intake,
  Languages,
  License,
  or,
  Readiness,
  RegisterError,
  Repo,
  Theme,
  Workflows
} from "./schema.ts"

const OnClone = { clone: Clone }
const step = <const P extends Schema.Struct.Fields, S extends Schema.Top>(name: string, success: S, payload: P) =>
  Action.make(`register-repository/${name}`, { payload, success, error: RegisterError, nondeterministic: true })

/** Confirms the served checkout is the linked repository and records its exact commit. */
export const CloneStep = step("clone", Clone, Input.fields)
export const ThemeStep = step("theme", or(Theme), OnClone)
export const LicenseStep = step("license", or(License), OnClone)
export const ChecksStep = step("checks", or(Checks), OnClone)
export const ReadinessStep = step("readiness", or(Readiness), { clone: Clone, checks: or(Checks) })
export const CleanupStep = step("cleanup", or(Cleanup), OnClone)
export const AgentShareStep = step("agent-share", or(AgentShare), OnClone)
export const CommitsStep = step("commits", or(Commits), OnClone)
export const ContributorsStep = step("contributors", or(Contributors), OnClone)
export const IntakeStep = step("intake", or(Intake), OnClone)
export const WorkflowsStep = step("workflows", or(Workflows), OnClone)
export const CiStep = step("ci", or(CiEstimate), OnClone)
export const LanguagesStep = step("languages", Languages, OnClone)

/** Setup's one step: run the detected checks once on the exported tree. */
export const VerifyStep = Action.make("register-repository/setup/verify", {
  payload: { repo: Repo, commit: Clone.fields.commit, checks: or(Checks) },
  success: Schema.Array(CommandRun),
  error: RegisterError,
  nondeterministic: true
})
