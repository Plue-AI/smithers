import { fixtures } from "@smthrs/rpc/fixtures/Setup"
import { SetupView } from "./SetupView"
export const setupStories = Object.entries(fixtures).map(([id, story]) => ({ id: `setup-${id}`, name: story.name, render: () => <SetupView {...story} onAction={() => {}} onView={() => {}} /> }))
