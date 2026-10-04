import { fixtures } from "@smthrs/rpc/fixtures/Terminal"
import { TerminalView } from "./TerminalView"
import { fixtureStories } from "./stories"

// Reuse the real emulator in the app-only slot; no transport or invented model fields.
export const stories = fixtureStories(fixtures, (fixture, callbacks) => <TerminalView {...fixture} {...callbacks}
  terminal={{ lines: [fixture.model.command ?? ""] }} />, Object.fromEntries(Object.values(fixtures).map(fixture => [fixture.name, [{ selector: ".xterm-helper-textarea", event: "keydown" as const, key: "k" }]])))
