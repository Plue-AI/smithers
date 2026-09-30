# TUI work

Read [README.md](README.md) before changing interaction, session, worker, or flow behavior; it is the current feature and command contract for this subtree. Verify the relevant implementation and tests on the revision being edited.

- Keep chat usable while a requested worker or flow runs. Persist a delegation request before returning `requested`; settle status from real execution and restore unfinished work from journal/session state after restart.
- Workers share the working directory. Assign parallel edits to disjoint files and keep queued work's captured context. Waiting for children releases a worker seat.
- The timeline and panels project persisted events. Inspection at a selected event cannot reveal later outcomes. `ui.publish` updates a validated panel without taking focus; an action on a panel runs only after the user invokes it.
- Flow listing is distinct from execution. A `flow.ts` edit after host warmup needs a restart before running it; do not run concurrent `smthrs` executors in the same directory.
- Undo refuses per file: changed since the run, outside the workspace, or an unsupported diff; the rest of the run still undoes. Shell-written files undo from the call's receipt, which leaves out files named writers touched meanwhile, and the person can uncheck any file. Changes outside a repository have no automatic shell diff.

- Keep input and status visible in short terminals. Bound help, forms, and toast stacks to the available pane height; keyboard navigation must reveal the focused field.
- Preserve every key in a terminal input burst. Focus changes must reach the native editor before later bytes arrive; verify focus-key plus text in one PTY write, including panels, worker steering, pickers, and forms.
