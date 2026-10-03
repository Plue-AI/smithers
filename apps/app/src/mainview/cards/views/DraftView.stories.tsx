import { fixtures } from "@smthrs/rpc/fixtures/Draft"
import { DraftView } from "./DraftView"
import { fixtureStories } from "./stories"

export const stories = fixtureStories(fixtures, (fixture, callbacks) => <DraftView {...fixture} {...callbacks} />,
  Object.fromEntries(Object.values(fixtures).filter(f => !f.model.committed).map(f => [f.name, [
    { selector: ".draft-field input", event: "input", value: "Edited title" },
    { selector: ".draft-field input", event: "focusout", gesture: "set", action: { tag: "form.set", args: { ...f.gestures.set!.args, field: "title", value: "Edited title" } } },
    { selector: ".draft-field textarea", event: "input", value: "Edited prompt" },
    { selector: ".draft-field textarea", event: "focusout", action: { tag: "form.set", args: { ...f.gestures.set!.args, field: "prompt", value: "Edited prompt" } } },
    { selector: ".draft-field:nth-child(3) textarea", event: "input", value: "Edited acceptance" },
    { selector: ".draft-field:nth-child(3) textarea", event: "focusout", action: { tag: "form.set", args: { ...f.gestures.set!.args, field: "acceptance", value: '["Edited acceptance"]' } } },
    { selector: "select", event: "change" },
    ...(f.model.issue ? [{ selector: 'input[type="checkbox"]', event: "click", action: { tag: "form.set", args: { ...f.gestures.set!.args, field: "fixes", value: String(!f.model.issue.fixes) } } }] : [])
  ]])) as Parameters<typeof fixtureStories>[2])
