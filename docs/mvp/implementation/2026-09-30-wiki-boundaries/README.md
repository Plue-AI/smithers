# Wiki import and view boundaries (#2312)

Imported Markdown titles use the existing backend YAML-aware parser for both navigation metadata and import naming: a nonempty valid string frontmatter title, then a real Markdown heading, then the filename. App projections display the stored title unchanged.

Product migration 0094 adds title ownership: `imported`, `explicit`, or `unknown`. New sync imports are marked imported. Every person-supplied title update marks explicit, including a title identical to the filename, slug, or previous generated title. This marker is written under the same revision fence as the page/CRDT update. Body-only edits preserve ownership. Imports rename only pages marked imported. Old rows become unknown: the earlier schema cannot prove who chose their titles, so migration and later imports preserve those bytes and revision history. Unknown titles can be explicitly renamed; filename equality never grants the importer authority.

Wiki listing cards have separate repository/space identities and retain the account and space of each fresh entry. Selection and rendering share a scope projection. Loaded pages must match the card's repository/space and current account. A legacy persisted entry lacking trustworthy scope is suppressed while its page is unavailable, including its title, path, slug and button arguments. A card's navigation tree uses its own repository rather than another currently selected repository.

Opening the Wiki pane reads its selected space and opens the first page (a Markdown read or an indexed attachment). Space choices, pane invocations, repository changes, account epochs and conversation changes fence both index and page responses. Explicit empty spaces remain selected; there is no automatic cross-space fallback. The read starts in the background and keeps Chat usable.

Regressions use synthetic documents and isolated local PostgreSQL databases. Local native helpers/FFI are existing artifacts; this change does not claim a fresh native rebuild or a hosted wiki audit. Validation and exact source hashes are retained in the campaign receipt.
