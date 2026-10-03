Implemented the required confirm.cancel stale refusal for #3692 on del/confirm-stale. Rebased onto origin/main c9875a624 before implementation. No deletions, push, merge, or issue mutations.

Decision: target_stale means a repository execution target disappeared from the graph (NativeFailureCodes.ts). Confirmation revision conflicts have a different meaning, so confirm_stale is a new native registry entry, encoded as native_confirm_stale, with user fault and HTTP 409.

The existing app confirmation authority is the durable message action created by requestFlowConfirmation. No confirm.cancel handler existed. Registered the person-only flow against that authority; new confirmations receive a revision, and cancellation checks the stored revision and answered state before dispatching a durable cancellation receipt. Missing confirmations and legacy actions without revisions fail closed. Existing history still decodes. The projection also checks the revision and terminal state before changing anything. The controller handler returns a typed Refusal; the shared flow binding treats it as a failure and uses the existing refusal copy renderer.

Updated both RPC docblocks and added the shared cancellation refusal constructor. Regression tests cover stale revisions, answered confirmations, missing confirmations, legacy history, pending success, the registered flow, repeat cancellation, and reload persistence. Updated the registry's person-only reason oracle.

API: ran timeout 600 node scripts/check-api-baseline.mjs --build-declarations --update, then verified with timeout 600 node scripts/check-api-baseline.mjs --build-declarations. Both PASS (49 public packages). The regenerated baseline changed @smthrs/build-cli, @smthrs/cli, and @smthrs/targets. These are baseline refreshes; no source in those packages changed. @smthrs/rpc is currently private and is excluded by this script; its source declarations changed as requested.

Validation (all typecheck/test commands used timeout 600):

- pnpm -F @smthrs/rpc typecheck: PASS.
- pnpm -F smithers-app typecheck: PASS.
- pnpm -F @smthrs/rpc exec vitest run test/cards/ConfirmCard.test.ts test/NativeFailureCodes.test.ts test/cards/CommandInputs.test.ts: PASS, 144 tests.
- bun test --isolate apps/app/src/mainview/flows/entries/confirm.test.ts apps/app/src/mainview/flows/agent-parity.test.ts apps/app/src/mainview/state/AppTransitionValidation.test.ts: PASS, 14 tests.
- pnpm -F @smthrs/rpc test: 3961 PASS / 2 FAIL. Both failures reproduce at the rebased base: Refusal.test.ts desktop_not_ready auto-retry and SourceComments.test.ts missing documentation paths (base: 3956 PASS / 2 FAIL).
- pnpm -F smithers-app test: 8315 PASS / 2 SKIP / 16 FAIL; completed in 427.65 seconds. All 16 failing cases reproduce at the rebased base. The final focused guard rerun confirmed the corrected Declare.ts site is absent.

The app's unrelated failures reproduce in an isolated worktree at c9875a624: raw-error sites in Settings/Setup/Todo/InstallSeam, raw-failure allowlist, E2E coverage missing-action, SyncCards rate-limit copy, AppController's installSnapshots composition oracle, FormCardsAgainstMain, RepositoryFlows, SharedOperations, SlashPayload, registry, and FlowName. An interim raw-error site introduced in Declare.ts was corrected to use refusalLine; the final focused raw-error run reports only the base's existing sites. The temporary base worktree was removed after comparison. No existing tests or thresholds were weakened.

Evidence logs from this session: /tmp/confirm-rpc-typecheck.log, /tmp/confirm-app-typecheck.log, /tmp/confirm-rpc-focused.log, /tmp/confirm-handler-tests.log, /tmp/confirm-rpc-tests.log, /tmp/confirm-app-tests.log, /tmp/confirm-api.log, /tmp/confirm-api-check.log, and /tmp/confirm-base-*.log.
