# T-APP-19b Card schemas match §14.3: one rpc reconciliation

Stage S1 · Size M · Depends on T-APP-19 · Unblocks T-APP-07, T-APP-09, T-APP-16, T-APP-17, T-APP-23, T-CAT-02, T-COL-02, T-GH-04, T-GH-05, T-GH-06, T-GH-07, T-GH-08, T-MCH-08, T-STK-10, T-UI-02, T-UI-03, T-UI-04, T-UI-05, T-UI-06, T-UI-07, T-UI-08, T-UI-09, T-UI-10, T-UI-11, T-UI-12, T-UI-13, T-UI-14, T-UI-23 · Issue: [#3601](https://github.com/smithersai/smithers/issues/3601) (in flight since 17:40, smithers-b8's lane; fold this ticket's field list into it)
Spec: spec.md §14.2.1, §14.3, §21.1 · Delta: delta.md §9 · Product: mvp.md §6, Appendix B · Props: [ui-components.md](../ui-components.md)

## Goal

Reconcile every card schema with §14.3 and ui-components.md in one packages/rpc change. T-UI-02 through T-UI-14 go Ready together after it lands. UI lanes never raise piecemeal schema changes.

## Ownership

smithers-b8 owns the app contract reconciliation. smithers-38 reviews packages/rpc and signs the public-API diff under §21.1 before landing. Design reviews fields against its mocks. The tech lead adopts every owner verdict in the UI pre-review inputs.

## Scope

In:
- Audit every §14.3 card and shell data schema, including nested fields, enum literals, callback inputs and view patches. Reconcile the whole contract, not only the listed gaps. Keep schemas and fixtures on per-module exports. Check: C-UI-08.
- Setup/Settings: app_manifest step id; blocked step and fix_url; this_mac limit and fix at capacity 0; Settings health (process, PostgreSQL size, disk free, GitHub sync and rate), plus Obsidian last_sync_at. Keep the third role label "<third role label: product ruling pending, batch 2>". Check: C-UI-08, C-UI-12.
- Draft: Commit input can carry title, prompt, acceptance, placement, issue fixes and seed. gestures.set carries string value: title/prompt unchanged, acceptance JSON array, place JSON object {mode, n?}, fixes "true"/"false". No invented Discard tag; product rules in Appendix B. Check: C-UI-08, C-UI-12.
- TODO: replace the single needs_you object with waits[] and per-wait actions; add authored steers, owner_removed, missing_tool and supplied image-add action, plus required on GitHub evidence. Cover simultaneous waits and their literal bound inputs. Check: C-UI-08, C-UI-12.
- Confirm: reconcile summary and nested review with §14.3. Receipt result is done|cancelled|expired. Subject kind is todo|branch|flow|agent|wiki; secret, member and settings are forbidden and get negative parse fixtures. Stale approval is separate from a receipt. actions[] binds approval/denial with subject/revision args; model.action only supplies the verb label. Product rules on Cancel in Appendix B. Check: C-UI-08, C-UI-12, C-UI-13.
- Home: actions on attention[] and background_runs[], plus owner/non-owner main.reset-to-github fixtures. Check: C-UI-08, C-UI-12.
- Shell: BranchTreeNode archive_count and action?; EntryRow tombstone; branch/archive navigation data; shared ShellView patches toast_hidden, jump_to, on_screen and timeline_visible. React nodes and callbacks are presentation slots, not serialized model data. Check: C-UI-08, C-UI-12.
- Members color_index and row actions; Flow step added?; File content text|too_large|binary, digest, mode, hover, reveal and FileBase github_url (required for binary/too_large); Diff against item_base|fork|burst, burst data, change/rename, binary sizes and hunks. Check: C-UI-08, C-UI-12.
- Run uses MonitorCard, not a duplicate RunCard: waits.settled, stable step key and usage, engine, journal, replay and shared view {selected, at}; retain stable phase/cell ids and summary/explain. Check: C-UI-08, C-UI-12.
- Agent: product-approved model-change tag with smithers-38 review; correct Edit instructions to the Draft-opening tag with prefilled text, never a todo.new binding that commits a TODO (smithers-b8 #3601). Keep the pending third-role label. Check: C-UI-08, C-UI-12.
- Commands synopsis, description and agent: run|confirm|never. Tags remain an opaque placeholder enum until T-CAT-01. Add fixtures for every gap smithers-38 listed across T-UI-02 through T-UI-14, and every state allowed by the reconciled contracts. Check: C-UI-08.

Out:
- UI implementation, Containers, services, permission policy, catalog invention, editor dependencies, clipboard export and visual changes. T-UI-01 exports copyText with execCommand fallback; T-UI-07/T-UI-08 extend shell seam scopes; T-UI-11 names its shared editor export and records exact dependency pins before Ready. Check: C-UI-08, C-UI-12.
- No agent confirmation path for Members, Secrets or Settings. No repository execution, imported-code evaluation or secret values in fixtures. No weakening of audience or owner authorization. Production wiring remains responsible for enforcement. Check: C-UI-08, C-UI-13.

## Changes

- Make one packages/rpc change for every §14.3 card schema, shared action/view/input types and fixture gap. Export schemas as @smthrs/rpc/<Card>Card and fixtures as @smthrs/rpc/fixtures/<Card>. rpc has no root export (packages/rpc/package.json:10). Use existing fixture modules BranchTreeNode, ContextLine, Toast and TimelineEntry; add EntryRow fixtures for tombstones. Check: C-UI-08.
- Match ui-components.md CardProps, including bound Action.args, named gestures and typed per-member view patches. Preserve opaque CatalogTag. Update schemas, consumers and documentation together. Do not leave two live contracts. Check: C-UI-08, C-UI-13.
- Add named literal fixtures for each Scope item, including malformed enums, forbidden Confirm subjects, binary/too-large GitHub links, simultaneous waits, owner/non-owner actions and Draft-opening instructions. Fixtures include name, model, actions, gestures, view and independently reviewed literal expectations. Check: C-UI-08, C-UI-12.
- Meet §21.1: identify callers, document exports with @since, use typed errors and no public any, preserve prior persisted records through explicit legacy decoding where needed, record removal migration guidance and RELEASE_SUPPORT.md support policy, and obtain smithers-38 public-API sign-off. Check: C-UI-08.

## Tests

- C-UI-08: all fixtures parse, unknown enums fail, forbidden Confirm secret/member/settings subjects fail, and nested fields/enum sets/view patches/command inputs match the adopted §14.3 and ui-components.md contract. The CI field script reads the spec; unit tests use committed independent literals and never read .specs at runtime.
- Import every fixture module through @smthrs/rpc/fixtures/<Card>, never a package root. Assert fixture coverage for every Scope item; assert action args and string encodings independently of production helpers. C-UI-08 proves this before any UI implementation exists.
- Keep retained schema snapshots unchanged. When a persisted model or enum changes, decode a previous-version fixture through the explicit legacy path and assert the current projection. Do not accept forbidden subjects as current Confirm models. Retain §21.1 coverage and any applicable dispatch/projection counter fixtures. Check: C-UI-08.
- C-UI-12 is downstream presentation proof by each UI ticket. C-UI-13 is downstream real-topic and role-bound action proof by wiring owners; neither blocks this schema-only ticket.

## Acceptance

- [C-UI-08](../checks/C-UI-08.md) passes every card and shell data contract, field comparison and fixture gap.
- smithers-38 signs the one packages/rpc public-API diff under §21.1. Record the product Appendix B rulings for Discard, Cancel and Change model before those tags enter current schemas/fixtures. Keep the third-role label pending.
- T-UI-02 through T-UI-14 header/index dependencies point here and go Ready together after landing. No UI lane raises a piecemeal schema change.

## Risks and notes

T-APP-19 landed short of its field/enum acceptance. This ticket closes that gap without reopening the frozen ticket. Missing Appendix B tags need product rulings; adoption of the owner verdict does not invent catalog authority. Historical records remain readable under §14.1.5; current forbidden Confirm subjects remain rejected.

## Ready checklist

1. Dependencies: T-APP-19 is landed. Product Appendix B rulings for Discard, Cancel and Change model are recorded before new tags are implemented.
2. Exclusions: no UI, Container, service, authorization-policy or repository-execution changes.
3. Tests: C-UI-08 covers all current schemas, every named gap, fixture subpath imports, independent literal inputs and previous-version decoding. C-UI-12/C-UI-13 remain downstream.
4. Decisions: smithers-b8 owns app contracts; smithers-38 signs packages/rpc under §21.1; product decides Appendix B tags and the final third-role label.
5. Owner pre-review before start: smithers-38: answered, BLOCKING edits applied (tech lead adopts). This records the adopted reconciliation ruling; smithers-38's promised T-APP-19b pre-review and final public-API sign-off remain required before implementation and landing respectively. smithers-b8: the T-UI verdicts are adopted here; a T-APP-19b-specific answer remains due.
6. Security: forbidden confirmation subjects fail current-schema parsing. Fixtures contain no secrets. Views execute no repository or imported tool content. Wiring enforces private audience and owner/session authorization at production boundaries; no fixture-only security claim. C-UI-08 and C-UI-13 prove their respective boundaries.
