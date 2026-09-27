---
title: Publish views and cards
description: Turn an agent result into a persistent, inspectable terminal view.
order: 15
section: Automate
---

A cell calls `ui.publish` with data. The TUI validates, persists, and renders it. Publishing does not steal focus or run an action.

## Publish a view

```tui-script custom-view
Use "panels"
Type "Show the addition checks in a custom view."
Press Enter
Wait for answer "Published the checks view."
Type "/ui checks"
Press Enter
Wait for "Addition"
Press l
Capture "Expand the code behind a result."
Press j
Press l
Capture "Inspect a table in the same view."
Press j
Press l
Capture "Inspect a diff and its available row action."
Press a
Capture "Run the selected open action only after pressing a."
```

```js
await ctx.call("ui.publish", {
  id: "checks",
  title: "Checks",
  summary: "Two addition checks passed.",
  rows: [{
    id: "addition",
    label: "Addition",
    status: "done",
    details: [{ kind: "code", language: "javascript", code: "assert(add(2, 3) === 5)" }]
  }]
})
```

`/ui id` opens a view; `/ui` opens the newest one. Reusing the same ID updates it in place. Workers' IDs are prefixed by their tab ID, so their views stay in their own lanes.

| Block | Required fields                             |
| ----- | ------------------------------------------- |
| Text  | `kind: "text"`, `text`                      |
| Code  | `kind: "code"`, `code`; optional `language` |
| Table | `kind: "table"`, `columns`, `rows`          |
| Diff  | `kind: "diff"`, `path`, unified `patch`     |

Rows can carry a status and an action. Use `{label,prompt}` to send a prompt, or `{label,action}` for a typed [extension action](./extensions.md). **a** runs the selected action; rendering the row does not.

## Add a live chat card

```tui-script live-card
Use "cards"
Type "Publish the addition checks as a card."
Press Enter
Wait for answer "Published the checks card."
Capture "Keep a live card, status item, and contributed key in chat."
Press Tab
Capture "Focus the newest card from an empty composer."
Press Enter
Wait for "Addition"
Capture "Open the card as a full view."
Press Escape
Press Alt+R
Capture "Open the same view with its contributed key."
```

Wrap the panel as `{kind:"panel", placement:"card", panel}` for a card. It shows the title, summary, and first five rows. **Tab** focuses cards; **Up/Down** select; **Enter** opens; **Esc** returns to the composer.

A bare panel may use `placement:"main"` for a view beside chat at 120 columns or above it on narrower terminals. `bind:{tree:rootId}` adds live worker rows. Reusing an ID refreshes its contents without changing focus.

## Size limits

A session keeps 24 panels/cards. A panel is at most 1 MB, with 500 rows and 40 detail blocks per row. Row IDs must be unique. Tables have at most 12 columns and 200 rows; individual block text is bounded to 200,000 characters. Oversized or malformed publications are refused to the calling cell.
