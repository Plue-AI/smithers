import { fixtures } from "@smthrs/rpc/fixtures/Terminal"
import { Terminal } from "@smthrs/ui/adapters/terminal"
import { TerminalView } from "./TerminalView"
import { fixtureStories } from "./stories"

// Reuse the real emulator in the app-only slot; no transport or invented model fields.
export const stories = fixtureStories(fixtures, (fixture, callbacks) => <TerminalView {...fixture} {...callbacks}
  terminal={<Terminal lines={[fixture.model.command ?? ""]} readOnly={!fixture.model.viewer_is_owner || fixture.model.frozen}
    palette="paper" fontSize={12.5} cursorBlink={fixture.model.viewer_is_owner && !fixture.model.frozen}
    aria-label={`${fixture.model.title} terminal`} />} />, Object.fromEntries(Object.values(fixtures).map(fixture => [fixture.name, [{ selector: ".xterm-helper-textarea", event: "keydown" as const, key: "k" }]])))
