/**
 * UI files that still render a raw error, with how many sites each has.
 *
 * Checked by RawErrorRender.test.ts. Move a site to `presentUserFailure`
 * (`@smthrs/rpc/UserFailure`) and lower or delete its entry; never add one.
 * The goal is an empty object.
 */
export const RAW_ERROR_RENDER_ALLOWLIST: Readonly<Record<string, number>> = {
  "src/mainview/ChatCards.tsx": 2,
  "src/mainview/StartupError.tsx": 3,
  "src/mainview/cards/BillingCards.tsx": 1,
  "src/mainview/cards/StackCard.tsx": 1,
  "src/mainview/cards/WorkflowCards.tsx": 2,
  "src/mainview/cards/WorkspaceCard.tsx": 1
}
