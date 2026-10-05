import { fixtures } from "@smthrs/rpc/fixtures/Timeline"
import { Timeline } from "../../Timeline"
import { fixtureStories } from "./stories"
import "../../styles/base.css"
import "../../styles/chrome.css"

export const stories = fixtureStories(Object.fromEntries(Object.entries(fixtures).map(([key, fixture]) => [key, { ...fixture, gestures: Object.fromEntries(fixture.model.lines.flatMap(line => line.action ? [[line.entry_id, line.action]] : [])) }])), (fixture, callbacks) => <Timeline {...fixture.model} onAction={callbacks.onAction} onView={patch => callbacks.onView({ ...patch })} />,
  Object.fromEntries(Object.values(fixtures).map(fixture => [fixture.name, fixture.model.lines.flatMap(line => [
    { selector: `li[data-entry="${line.entry_id}"] > button`, patch: { jump_to: line.entry_id } },
    ...(line.action ? [{ selector: `li[data-entry="${line.entry_id}"] button[data-flow]`, gesture: line.entry_id, action: { tag: line.action.tag, args: line.action.args ?? {} } }] : [])
  ])])))
