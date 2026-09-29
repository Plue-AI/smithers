/**
 * UI files that still render a raw error, with how many sites each has.
 *
 * Checked by RawErrorRender.test.ts. Move a site to `presentUserFailure`
 * (`@smthrs/rpc/UserFailure`) and lower or delete its entry; never add one.
 * The goal is an empty object.
 */
export const RAW_ERROR_RENDER_ALLOWLIST: Readonly<Record<string, number>> = {
  "src/mainview/cards/AgentCards.tsx": 3,
  "src/mainview/cards/ApprovalAnswer.tsx": 1,
  "src/mainview/cards/CodingPlanCard.tsx": 1,
  "src/mainview/cards/FlowFormCards.tsx": 1,
  "src/mainview/cards/FlowGraphDrawer.tsx": 1,
  "src/mainview/cards/RegistrationCard.tsx": 1,
  "src/mainview/cards/RepositoryChoiceCard.tsx": 2,
  "src/mainview/cards/RepositorySetupCard.tsx": 1,
  "src/mainview/SearchPalette.tsx": 1
}
