# C-UI-02 Product words and minimal text in cards

Proves: mvp.md §2 rule 7, §3 Vocabulary, §9 Copy · spec.md §14.2, §14.3, §14.6b · Layer: unit · Stage: S1 · Tickets: T-CAT-01, T-UI-14
Automation: `apps/app/src/mainview/cards/ProductWords.test.tsx` (new), with the term list `apps/app/src/mainview/cards/productWords.ts` (new) · Runs in: CI

## Setup
- The card registry (`apps/app/src/mainview/cards/CardRenderers.tsx`) and one state fixture per card state the spec §14.3 model allows, added by each card's ticket. happy-dom (already an app dev dependency).
- The banned-term list, exactly as §14.6b sets it: workflow, thread, task, lane, box, workspace, mythical, sandbox, VM, seat, profile. C-CAT-03 reads the same file.
- Content regions are marked `data-content` and excluded: prompts, transcripts, file text, diffs, wiki pages, Markdown answers, and GitHub text quoted verbatim.

## Steps
1. Render every card in every fixture state, inline and maximized, in light and dark themes.
2. Collect the chrome text outside content regions: headings, labels, buttons, chips, empty and error states, toasts, `aria-label`, `title` and tooltip text.
3. Check each chrome text node for banned terms (whole word, case-insensitive), its word count, and explanatory sentences, including the phrases AGENTS.md "MINIMAL TEXT" names ("not measured yet", provenance footers, a sentence restating the button beside it).
4. Read the Settings card's host label.
5. Count rendered card-state pairs against the registry × states.

## Pass when
- Zero banned terms.
- Every card body line has at most 12 words, and no node is an explanatory sentence (§14.6b).
- Zero "not measured yet" rows, provenance footers or restating sentences.
- Step 4: the detected host is labeled "This Mac" (§14.3).
- Step 5: the rendered count equals registry × states; no card or state is skipped.

## Fail when
- A card renders lazily or behind a flag and escapes the scan.
- Chrome copy is wrapped in `data-content` to dodge the check.
- A banned term hides in an `aria-label` or tooltip, which assistive technology reads aloud.
- Settings shows "host profile" or "VM" for the detected host.

## Evidence
`.artifacts/checks/C-UI-02/<UTC timestamp>/`: test output with a per-card table (states rendered, words per line, violations), the term list used, commit.
