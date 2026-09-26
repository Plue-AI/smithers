# Custom UI example

`flows/release-plan/flow.mdx` is a custom agent whose `metadata.tui` adds a
key and a status item, and whose cells publish a live card and a footer item
with `ui.publish`. Nothing here is imported: the TUI reads the frontmatter.

| Source                                                    | Shows                                                                         | Does                                                                                        |
| --------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `keys: [{ key: alt+p, label: Plan release }]`             | `alt+p Plan release` in the key hints and the `?` popup, under `release-plan` | Starts the agent with `Plan release` as its prompt (a key without an action runs its owner) |
| `status: true`                                            | The agent's latest run in the footer                                          | Click opens its tab                                                                         |
| `ui.publish({ kind: "panel", placement: "card", panel })` | A card in the chat, updated in place on each republish                        | Click opens it as a view; `a` runs a row's action                                           |
| `ui.publish({ kind: "status", status })`                  | A footer item (24 characters)                                                 | Click runs its action, if any                                                               |

Run the TUI here and press `alt+p`:

```sh
bun run tui apps/tui/examples/custom-ui   # from the repository root
```

Edit the key or label in `flow.mdx` while the TUI runs: the hints change within
one 300 ms debounce, with no restart. A key that collides with a built-in key,
or with another flow's key, is refused and shows as `✗ 1 extension` in the
footer; click it for the reason.
