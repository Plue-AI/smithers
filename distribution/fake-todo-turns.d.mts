/** Types for fake-todo-turns.mjs, which node runs untyped in the J1 rehearsal and the walk's model stand-in imports. */
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
export declare const todoTurn: (messages: ReadonlyArray<TodoChatMessage>, greeting?: string) => { readonly step: string; readonly content: string } | undefined
export declare const isTodoJudgement: (questions: Readonly<Record<string, unknown>> | null | undefined) => boolean
export declare const todoAnswer: (name: string, question: TodoEvaluationQuestion) => TodoEvaluationAnswer
