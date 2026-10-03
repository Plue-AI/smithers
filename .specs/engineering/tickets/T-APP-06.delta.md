# T-APP-06 reuse delta

| File | Existing code reused / why added lines are needed |
| --- | --- |
| `cards/MembersCard.tsx` | Reuses MembersView, cardActions and ProductActor. No legacy Members card or roster consumer exists; IssueCards/GithubParts people helpers render GitHub assignees, not install membership. Ticket Changes explicitly permits this card. Kept unmounted while dependencies and joint checks are pending. |
| `state/seams/MembersSeam.ts` | Reuses LiveChannel, InstallErrorSchema and installRequestId. InstallSeam owns a different install projection and setup authority; cannot provide the Members roster lifecycle. New seam preserves committed roster through reconnect reads and typed refusal envelopes. |
| `flows/entries/members.ts` | No Members entry exists. Org/account commands have different subjects and authority. Dark declarations refuse; no catalog registration or mutation fallback. |
| `cards/MembersCard.test.tsx` | No Members container tests exist. Literal controls, routes, refusals, races and missing-provider effects verify the new boundaries. Transport doubles are unit-only and do not claim production-route integration evidence. |
| `T-APP-06.delta.md` | Lane-specific reuse receipt required by T-APP lane rules; no shared delta edit. |

Pending: production composition/catalog binding, RPC wire registration (smithers-38), shared login validator export (T-ACC-02), Remove confirmation in design's MembersView, and backend/journey evidence. No legacy card, CSS, tests or catalog entries exist to delete.
