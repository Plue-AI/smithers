# Vim buffers and keyboard panes

Choose **Mode → Vim** (`M`, Down, Enter from Normal mode). The preference is
saved with the session. The keyboard hint shows whether the current field is
in INSERT, NORMAL, or VISUAL mode. Other modes keep their existing input behavior.

## Move between panes

Press and release **Ctrl+B**, then the next key. The prefix works while editing,
in a terminal, and in the tutorial. Its hint stays visible until
you choose a command or cancel it.

| Next key | Action |
| --- | --- |
| Arrow keys, or H/J/K/L | Focus the pane in that direction |
| O | Cycle to the next visible pane |
| ; | Return to the previously focused pane |
| Q, then 0–9 | Show pane numbers and focus one |
| ? | Show the keyboard reference |
| Escape | Cancel the prefix without changing the buffer |
| Ctrl+B | Pass a literal Ctrl+B through to the current editor or terminal |

These use [tmux's default prefix and pane commands](https://man.openbsd.org/tmux),
with H/J/K/L aliases for directional movement. Pane numbers follow visible DOM
order and remain fixed while the number overlay is open. More than ten panes
remain reachable with O or directional movement.

A pane restores its last focused control and cursor. H/J/K/L moves through
controls inside it; Tab/Shift+Tab and native Enter/Space activation remain
available. Search results support J/K and arrows after selecting their pane.
Hidden or inert panes are excluded. Confirmation dialogs retain their modal
boundary. In Vim mode, Chat is a nonmodal bottom dock so the workspace remains
reachable while the draft stays open.

## Edit text

Text fields initially accept typing in INSERT mode. Escape enters NORMAL mode
without closing Chat or blurring the field. I/A resume insertion; V selects text.
Each mounted field retains its editing mode when moving between panes.

Supported normal-mode commands:

- `h/j/k/l` and arrows; `w/b/e` word motions over whole characters (accents and astral letters stay attached); `0/^/$` line motions; `gg/G` first/last line.
- `i/a` and `I/A` insert at the cursor or line boundary; `o/O` open a line.
- `d/c/y` followed by a motion delete, change, or copy; `dd/cc/yy` act on lines.
- `x` deletes, `r` replaces a character (any one Unicode character, digits and `u` included), `p/P` paste, `u` undoes, Ctrl+R redoes.
- Counts such as `3w` and `2dd`; visual motions with D/C/Y to act on the selection.

The unnamed copy register is shared across fields. This is a native text-field
Vim adapter, not a full Vim runtime: Ex commands, macros, plugins, and the system
clipboard register are not implemented. Native select, checkbox, slider and
other non-text controls retain their normal semantics. Terminals retain their
own editing keys, including their own Vim sessions; only the pane prefix is
intercepted. Editable Markdown uses a source textarea in Vim mode and the rich
editor in other modes, saving through the same existing change handler.

The runtime owns only transient keyboard state. Text changes dispatch native
input events to the field's existing React handler and flow, so persisted data
continues to use the app's shared transition dispatcher.

## Add a pane

Mark a region with `data-keyboard-pane="Descriptive name"`. Keep its controls
native and accessible; no registration or focus state belongs in a component.
The shell's ref-owned `bindKeyboardInput` listener discovers current panes when
a command is invoked, respecting native modal boundaries and hidden content.

Regression checks live in `runtime/VimBuffer.test.ts`, `runtime/KeyboardInput.test.ts`,
and `e2e/playwright/keyboard-panes.spec.ts`.
