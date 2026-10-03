import { fixtures } from "@smthrs/rpc/fixtures/Draft"
import { DraftView } from "./DraftView"
import { fixtureStories } from "./stories"

export const stories = fixtureStories(fixtures, (fixture, callbacks) => <DraftView {...fixture} {...callbacks} />,
  Object.fromEntries(Object.values(fixtures).filter(f => !f.model.committed).map(f => [f.name, [
    { selector: ".draft-field input", event: "focusout", gesture: "set", action: { tag: "form.set", args: { ...f.gestures.set!.args, field: "title", value: f.model.title } } },
    { selector: ".draft-field textarea", event: "focusout", action: { tag: "form.set", args: { ...f.gestures.set!.args, field: "prompt", value: f.model.prompt } } },
    { selector: ".draft-field:nth-child(3) textarea", event: "focusout", action: { tag: "form.set", args: { ...f.gestures.set!.args, field: "acceptance", value: JSON.stringify(f.model.acceptance) } } },
    { selector: "select", event: "change", action: { tag: "form.set", args: { ...f.gestures.set!.args, field: "place", value: JSON.stringify(f.model.place.mode === "append" ? { mode: "append" } : { mode: f.model.place.mode, n: f.model.place.n }) } } },
    ...(f.model.issue ? [{ selector: 'input[type="checkbox"]', event: "click", action: { tag: "form.set", args: { ...f.gestures.set!.args, field: "fixes", value: String(!f.model.issue.fixes) } } }] : [])
  ]])) as Parameters<typeof fixtureStories>[2])
