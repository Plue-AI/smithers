import type { CodeEditorViewProps } from "@smthrs/rpc/FileCard"
import type { ViewStory } from "./stories"
import { CodeEditorView as CodeSurface } from "./CodeEditorView"
import { fixtures as fileFixtures } from "@smthrs/rpc/fixtures/File"
const fileStates = { deleted: fileFixtures.deleted, renamed: fileFixtures.renamed, outside: fileFixtures.outside, comparing: fileFixtures.comparing, deleted_readonly: { ...fileFixtures.deleted, actions: [] }, renamed_readonly: { ...fileFixtures.renamed, actions: [] }, outside_readonly: { ...fileFixtures.outside, actions: [] }, restore_disabled: { ...fileFixtures.deleted, actions: fileFixtures.deleted.actions.map(action => ({ ...action, disabled: { reason: "Waiting for a machine" } })) } }
export const stories: ViewStory[] = Object.entries(fileStates).map(([name, story]) => ({ name, expect: story.expect, actions: story.actions, render: (callbacks, actions = story.actions) => <CodeSurface {...story} actions={actions as CodeEditorViewProps["actions"]} {...callbacks} /> }))
