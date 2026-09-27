---
title: Contribute keys and status
description: Expose repository actions through the terminal’s existing controls.
order: 16
section: Automate
---

Repository metadata and runtime cells use the same serializable contribution format. A contribution can be a panel/card, a status item, or a key. The host owns rendering, focus, and dispatch.

## Declare a repository shortcut

```yaml
metadata:
  tui:
    keys:
      - key: alt+r
        label: Review
    status: true
    card: true
```

Put this in a Markdown flow's frontmatter. With no explicit action, the shortcut invokes its owner; an agent uses the label as its prompt. In `SKILL.md`, where metadata values must be strings, `tui` can contain the same mapping encoded as a JSON string.

```tui-script repository-extension
Use "extensions"
Wait for "alt+r Review"
Capture "A repository contribution appears in the normal key hints."
Press Alt+R
Wait for answer "Review complete"
Capture "Invoke the contributed agent and inspect its result."
```

Changes under `flows/` replace repository contributions within 300 ms. Metadata discovery does not import or execute the flow. TypeScript execution still needs a restart after an imported module changes.

## Publish a key or status item

```js
await ctx.call("ui.publish", {
  kind: "key",
  key: { id: "checks", key: "alt+r", label: "Checks", action: { kind: "open", surface: "ui:checks" } }
})
await ctx.call("ui.publish", {
  kind: "status",
  status: { id: "checks", text: "Checks passed", tone: "success", action: { kind: "open", surface: "ui:checks" } }
})
```

See the [live card recording](./views.md#add-a-live-chat-card) for those contributions in use. Status text is one line, at most 24 characters; three items are shown. Tones are `info`, `success`, `warning`, and `danger`.

| Action | Fields                         | Result                                                                |
| ------ | ------------------------------ | --------------------------------------------------------------------- |
| Prompt | `kind:"prompt", prompt`        | Sends a prompt to chat.                                               |
| Flow   | `kind:"flow", flow, input?`    | Requests a durable flow; missing input opens its form.                |
| Agent  | `kind:"agent", agent, prompt?` | Starts the named worker or asks for its prompt.                       |
| Open   | `kind:"open", surface`         | Opens `chat`, `summary`, `smithers`, `tab:id`, `flow:id`, or `ui:id`. |

Global keys require Ctrl or Alt. Panel-scoped keys may use `context:"panel"`. Each owner may contribute eight keys. Built-in keys win; collisions between owners are also refused. Runtime callers receive a reason. Repository problems appear as an Extensions footer item that opens the problem list.

The Smithers run view and monitor status use this same contribution mechanism. `apps/tui/examples/custom-ui` provides a repository example.
