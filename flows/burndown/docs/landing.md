# Landing verification

The merge queue checks an archive of the final rebased candidate, leaving the
shared checkout intact. Every changed path needs a verification route; empty
changes, empty affected selections, missing tools, and unknown ownership fail.

Smithers uses the candidate's local affected graph for non-Go changes, including
root scripts and documentation. It lists each path separately before executing
the combined CI selection without cached results. The candidate's Node and pnpm
pins must match; offline frozen installation links local packages in the archive.
Go changes run vet and tests from their nearest module. Module metadata selects
the whole module. Helm changes run strict lint and template rendering from their
owning chart. Other repositories use owning package checks; unowned documentation
and executable files are quarantined rather than reported as checked.

Discovery, installation, and checks share a 15-minute deadline. Cancellation
kills the active process group and removes the archive. Failures retain the last
4,000 bytes in the quarantine receipt and the full check log on the host.

A verified non-operator Claude subscription reviews the final rebased diff with
Fable before push. The review receipt names the candidate SHA; the queue refuses
any SHA change after checks or review. Cloud artifact review alone is insufficient.
Review has a ten-minute deadline. Issue completion and release use the claim tool;
receipt failures are retained and surfaced even after a successful push.
