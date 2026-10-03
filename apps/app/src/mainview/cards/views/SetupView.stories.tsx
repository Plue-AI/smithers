import { fixtures, personOnlyFixtures } from "@smthrs/rpc/fixtures/Setup"
import { SetupView } from "./SetupView"
import { fixtureStories } from "./stories"
export const stories = fixtureStories({ ...fixtures, ...personOnlyFixtures }, (story, callbacks) => <SetupView {...story} {...callbacks} />)
