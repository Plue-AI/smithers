/** Types for fake-todo-turns.mjs, which node runs untyped in the rehearsals and the walk's model stand-in imports. */
export interface TodoChatMessage {
  readonly role?: unknown
  readonly content?: unknown
}
export interface TodoEvaluationQuestion {
  readonly type?: unknown
  readonly criteria?: unknown
}
export type TodoEvaluationAnswer =
  | { readonly type: "boolean"; readonly probability: number }
  | { readonly type: "score"; readonly score: number }
  | { readonly type: "choice"; readonly choice: string }

export declare const GREETING: string
export declare const subject: string
export declare const text: (content: unknown) => string
export declare const done: (value: unknown) => string
export declare const systemOf: (messages: ReadonlyArray<TodoChatMessage>) => string
export interface TodoMarkers {
  readonly ask: boolean
  readonly fail: boolean
  readonly fixed: boolean
  readonly pr: boolean
  readonly hold: string | undefined
  readonly resolve: boolean
  readonly file: string | undefined
  readonly flowedit: boolean
  readonly changelog: boolean
}

export declare const QUESTION: string
export declare const CHANGELOG_STEP: string
export declare const markersOf: (value: unknown) => TodoMarkers
export declare const todoTurn: (
  messages: ReadonlyArray<TodoChatMessage>,
  greeting?: string
) => { readonly step: string; readonly content: string; readonly hold?: string } | undefined
export declare const isTodoJudgement: (questions: Readonly<Record<string, unknown>> | null | undefined) => boolean
export declare const todoAnswer: (name: string, question: TodoEvaluationQuestion) => TodoEvaluationAnswer
