import { fixtures } from "@smthrs/rpc/fixtures/Secrets"
import { SecretsView } from "./SecretsView"
import type { ViewStory } from "./stories"

export const stories: ViewStory[] = Object.entries(fixtures).map(([name, fixture]) => ({
  name, expect: ["Secrets", ...fixture.expect],
  actions: [...fixture.model.secrets.flatMap(secret => secret.actions), ...fixture.actions],
  render: (callbacks, removed) => {
    let skip = removed !== undefined
    const keep = () => { if (skip) { skip = false; return false }; return true }
    return <SecretsView {...fixture} model={{ ...fixture.model, secrets: fixture.model.secrets.map(secret => ({ ...secret, actions: secret.actions.filter(keep) })) }} actions={fixture.actions.filter(keep)} {...callbacks} />
  },
}))
