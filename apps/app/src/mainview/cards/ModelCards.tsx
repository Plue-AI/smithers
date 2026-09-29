/*
 * The Models card: the configured models, each one's last test, and the seats
 * that read them. A credential is a NAME the host resolves, so the card has
 * nothing to mask, and a passing test's sample is never drawn. Embedded it is a
 * few rows and New, or, surfaced unasked, the one row and one button that need
 * someone. Maximized it is the list, the selected model's facts and the seats.
 * Selection and assignment are flows (model.show, model.assign), never
 * component state, and the presentation arrives through CardActions so the
 * other presentation's buttons are not in the DOM at all. Compose opens the
 * model's composer, its own card (ModelCallCard.tsx).
 */
import { Button } from "@smthrs/ui"
import { MODEL_SEAT_DEFAULT, modelKindOf, modelSeat, modelTestFixOf, modelTestStateOf, seatAccepts } from "@smthrs/rpc/ConfiguredModel"
import type { ModelTestFailure, ModelTestRecord } from "@smthrs/rpc/ConfiguredModel"
import type { UserFailure, UserFailureCopy } from "@smthrs/rpc/UserFailure"
import { describedFailure, FailureNotice } from "../FailureNotice"
import { useLiveQuery } from "@tanstack/react-db"
import { flowAction, flowProps } from "../flows/FlowAction"
import { flowArgs } from "../flows/FlowArgs"
import type { Card } from "../state/AppState"
import type { CardFamily, CardProjectionAuthority, RunCommand } from "./CardFamily"
import { ModelCallCardBody, modelCallPill } from "./ModelCallCard"

type ModelsCard = Extract<Card, { kind: "models" }>
type Model = ModelsCard["payload"]["models"][number]
type Presentation = "embedded" | "maximized"

/** How many rows the embedded card shows before the rest become a count. */
const EMBEDDED_ROWS = 4

/** The failure as its code plus its number or name. Every part is typed; the timeout reads the deadline that armed it. */
const failureText = (failure: ModelTestFailure): string => {
  switch (failure.code) {
    case "refused":
      return `${failure.code} · ${failure.status}`
    case "timeout":
      return `${failure.code} · ${failure.deadlineMs} ms`
    case "invalid":
      return `${failure.code} · ${failure.field}`
    case "credential_missing":
    case "credential_unknown":
      return `${failure.code} · ${failure.credential}`
    case "host_refused": {
      const detail = failure.refusal ?? failure.status
      return detail === null ? failure.code : `${failure.code} · ${detail}`
    }
    case "unreachable":
    case "empty_output":
    case "endpoint_forbidden":
    case "model_not_allowed":
      return failure.code
    default:
      return failure satisfies never
  }
}

/**
 * A host with an identity seam asks a signed-out caller to sign in. That is an
 * expected condition of not having an account yet, not a failure of anything
 * the user configured, so it is offered as the step it is (auth.prompt) and
 * never announced as an error.
 */
const signInRefused = (failure: ModelTestFailure): boolean =>
  failure.code === "host_refused" && failure.refusal === "sign_in_required"

/*
 * What a failed catalog read says, by the failure's code; the code line stays
 * behind Details. `host_refused` carries the refusal's own fault.
 */
const MODEL_REFRESH_FAILURES: { readonly [C in ModelTestFailure["code"]]: (failure: Extract<ModelTestFailure, { readonly code: C }>) => UserFailureCopy } = {
  unreachable: () => ({ fault: "dependency", sentence: "The model host did not answer. Not your fault.", actions: ["retry"] }),
  empty_output: () => ({ fault: "dependency", sentence: "The model host answered with nothing. Not your fault.", actions: ["retry"] }),
  refused: (failure) => failure.status === 429
    ? { fault: "wait", sentence: "The model host is busy. Not your fault.", actions: ["retry"] }
    : failure.status >= 500
    ? { fault: "dependency", sentence: "The model host failed to list models. Not your fault.", actions: ["retry"] }
    : { fault: "user", sentence: "The model host refused to list models. Check its credential.", actions: ["retry"] },
  timeout: () => ({ fault: "dependency", sentence: "The model host took too long to answer. Not your fault.", actions: ["retry"] }),
  invalid: () => ({ fault: "user", sentence: "A model setting is invalid. Edit it and try again.", actions: [] }),
  credential_missing: () => ({ fault: "infra", sentence: "A credential this host needs is not set. Not your fault.", actions: ["retry"] }),
  credential_unknown: () => ({ fault: "user", sentence: "A model names a credential this host does not know.", actions: [] }),
  endpoint_forbidden: () => ({ fault: "user", sentence: "A credential is not allowed for this model's address.", actions: [] }),
  model_not_allowed: () => ({ fault: "user", sentence: "This model is not allowed for decisions.", actions: [] }),
  host_refused: (failure) => failure.fault === "user"
    ? { fault: "user", sentence: "Smithers refused to list models.", actions: ["retry"] }
    : { fault: failure.fault, sentence: "Smithers could not list models. Not your fault.", actions: ["retry"] }
}

/* A refresh error whose typed failure did not survive. */
const MODELS_FAILED: UserFailureCopy = { fault: "infra", sentence: "Smithers could not list models. Not your fault.", actions: ["retry"] }

const refreshFailure = (failure: ModelTestFailure | undefined, line: string): UserFailure => {
  if (failure === undefined) return describedFailure("ModelsFailed", MODELS_FAILED, line)
  const copy = (MODEL_REFRESH_FAILURES[failure.code] as (failure: ModelTestFailure) => UserFailureCopy)(failure)
  return describedFailure(`models.${failure.code}`, copy, line === "" ? failureText(failure) : line)
}

/** A dot, then the latency or the typed failure. No sentence. */
const TestMark = ({ test, running }: { readonly test: ModelTestRecord | undefined; readonly running: boolean }) => (
  <span className="models-test" role={!running && test?.result.ok === false && !signInRefused(test.result.failure) ? "alert" : undefined}>
    <span className="models-dot" aria-hidden="true" />
    {running || test === undefined ? null : test.result.ok ? `${test.result.latencyMs} ms` : failureText(test.result.failure)}
  </span>
)

/**
 * Test and Compose for every model; Edit and Remove only for a record the user
 * owns, and only where the row has the width: a `brief` row (the pane's list,
 * a column beside the facts) leaves them to the facts of the selected model.
 */
const ModelActs = ({ model, running, onRunCommand, brief = false }: { readonly model: Model; readonly running: boolean; readonly onRunCommand: RunCommand; readonly brief?: boolean }) => (
  <>
    <Button size="sm" variant="outline" disabled={running} {...flowAction(onRunCommand, "model.test", model.id)}>Test</Button>
    <Button size="sm" variant="ghost" {...flowAction(onRunCommand, "model.compose", model.id)}>Compose</Button>
    {model.builtin === true || brief ? null : <Button size="sm" variant="ghost" {...flowAction(onRunCommand, "model.edit", model.id)}>Edit</Button>}
    {model.builtin === true || brief ? null : <Button size="sm" variant="ghost" {...flowAction(onRunCommand, "model.remove", model.id)}>Remove</Button>}
  </>
)

/** The one element that carries `data-model-id`. `acts` is off for the unasked row, whose single button sits beside it. */
const ModelRow = ({
  model,
  card,
  onRunCommand,
  selected,
  selectable,
  acts,
  brief
}: {
  readonly model: Model
  readonly card: ModelsCard
  readonly onRunCommand: RunCommand
  readonly selected: boolean
  readonly selectable: boolean
  readonly acts: boolean
  readonly brief?: boolean
}) => {
  const test = card.payload.tests.find((record) => record.id === model.id)
  const running = card.payload.testing.includes(model.id)
  const state = modelTestStateOf(test, running)
  const failure = state === "failed" && test?.result.ok === false ? test.result : undefined
  const text = (
    <span className="workflow-list-text">
      <strong>{model.id}</strong>
      <span>{modelKindOf(model.protocol)}</span>
    </span>
  )
  return (
    <li
      className="workflow-list-row models-row"
      data-testid={`model-row-${model.id}`}
      data-model-id={model.id}
      data-test-state={state}
      data-failure-code={failure?.failure.code}
      data-failure-fault={failure?.fault}
      data-builtin={model.builtin === true ? "true" : undefined}
      data-selected={selected ? "true" : undefined}
    >
      {selectable ?
        <button type="button" className="models-row-select" aria-pressed={selected} {...flowAction(onRunCommand, "model.show", model.id)}>{text}</button> :
        text}
      <TestMark test={test} running={running} />
      {acts ? <span className="flow-run-actions"><ModelActs model={model} running={running} onRunCommand={onRunCommand} brief={brief} /></span> : null}
    </li>
  )
}

/** The one row and one button an unasked card carries; `undefined` when what it named is gone. */
const attentionOf = (card: ModelsCard, onRunCommand: RunCommand) => {
  const { attention, models, seats } = card.payload
  if (attention === undefined) return undefined
  if (attention.kind === "seat-unresolved") {
    const assigned = seats.find((seat) => seat.id === attention.seat)?.recordId
    const record = models.find((model) => model.id === assigned)
    const missing = record !== undefined && card.payload.credentials.find((row) => row.name === record.credential)?.present !== true
    return (
      <div className="models-attention" data-testid="models-attention" data-kind={attention.kind}>
        <ul className="workflow-list">
          <li className="workflow-list-row">
            <span className="workflow-list-text">
              <strong>{modelSeat(attention.seat).label}</strong>
              <span>{missing ? `credential_missing · ${record.credential}` : assigned ?? ""}</span>
            </span>
          </li>
        </ul>
        <div className="flow-run-actions">
          <Button size="sm" data-testid="models-attention-fix" {...flowAction(onRunCommand, "model.assign", attention.seat)}>Assign</Button>
        </div>
      </div>
    )
  }
  const model = models.find((row) => row.id === attention.recordId)
  if (model === undefined) return undefined
  const result = card.payload.tests.find((test) => test.id === model.id)?.result
  // The record's own mistake is edited; a fault that is not the record's is tried again.
  const fix = result?.ok === false && signInRefused(result.failure) ? "sign-in" : modelTestFixOf(model.builtin === true, result)
  return (
    <div className="models-attention" data-testid="models-attention" data-kind={attention.kind}>
      <ul className="workflow-list">
        <ModelRow model={model} card={card} onRunCommand={onRunCommand} selected={false} selectable={false} acts={false} />
      </ul>
      <div className="flow-run-actions">
        {fix === "sign-in" ?
          <Button size="sm" data-testid="models-attention-fix" {...flowAction(onRunCommand, "auth.prompt")}>Sign in</Button> :
          fix === "test" ?
          <Button size="sm" data-testid="models-attention-fix" {...flowAction(onRunCommand, "model.test", model.id)}>Test</Button> :
          <Button size="sm" data-testid="models-attention-fix" {...flowAction(onRunCommand, "model.edit", model.id)}>Edit</Button>}
      </div>
    </div>
  )
}

/** The selected model's facts. It never carries `data-model-id`: the row alone does. */
const Detail = ({ model, card, onRunCommand }: { readonly model: Model; readonly card: ModelsCard; readonly onRunCommand: RunCommand }) => {
  const credential = card.payload.credentials.find((row) => row.name === model.credential)
  return (
    <section className="models-detail" data-testid="model-detail" aria-label={model.id}>
      <table className="secrets-table">
        <tbody>
          <tr><th scope="row">Protocol</th><td>{model.protocol}</td></tr>
          <tr><th scope="row">Model</th><td>{model.modelId}</td></tr>
          {model.baseUrl === undefined ? null : <tr><th scope="row">URL</th><td>{model.baseUrl}</td></tr>}
          {model.path === undefined ? null : <tr><th scope="row">Path</th><td>{model.path}</td></tr>}
          <tr>
            <th scope="row">Credential</th>
            <td data-testid="model-credential" data-present={credential?.present === true ? "true" : "false"}>
              {model.credential}{credential?.present === true ? "" : " · missing"}
            </td>
          </tr>
        </tbody>
      </table>
      <div className="flow-run-actions">
        <ModelActs model={model} running={card.payload.testing.includes(model.id)} onRunCommand={onRunCommand} />
      </div>
    </section>
  )
}

/**
 * One native select per seat the host listed. Its first option is the host's default; a record that is gone stays visible.
 * The line is `<seat> <name|default>`: a seat id and a record id, neither of which can hold whitespace.
 */
const Seats = ({ card, onRunCommand }: { readonly card: ModelsCard; readonly onRunCommand: RunCommand }) =>
  card.payload.seats.length === 0 ? null : (
    <table className="secrets-table models-seats" aria-label="Seats" data-testid="model-seats">
      <thead>
        <tr>
          <th scope="col">Seat</th>
          <th scope="col">Model</th>
        </tr>
      </thead>
      <tbody>
        {card.payload.seats.map((seat) => {
          const label = modelSeat(seat.id).label
          const accepted = card.payload.models.filter((model) => seatAccepts(seat.id, model.protocol))
          return (
            <tr key={seat.id} data-seat-row={seat.id} data-resolvable={seat.resolvable ? "true" : "false"}>
              <td className="world-card-title">{label}</td>
              <td>
                <select
                  className="sui-input"
                  aria-label={label}
                  data-seat={seat.id}
                  {...flowProps("model.assign")}
                  value={seat.recordId ?? MODEL_SEAT_DEFAULT}
                  onChange={(event) => onRunCommand("model.assign", flowArgs("model.assign", { seat: seat.id, recordId: event.currentTarget.value }))}
                >
                  <option value={MODEL_SEAT_DEFAULT}>Default</option>
                  {seat.recordId === null || accepted.some((model) => model.id === seat.recordId) ? null : <option value={seat.recordId}>{seat.recordId}</option>}
                  {accepted.map((model) => <option key={model.id} value={model.id}>{model.id}</option>)}
                </select>
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )

export const ModelsCardBody = ({
  card,
  onRunCommand,
  presentation
}: {
  readonly card: ModelsCard
  readonly onRunCommand: RunCommand
  readonly presentation: Presentation
}) => {
  const { models, selected, error, refresh, host } = card.payload
  const create = <Button size="sm" data-testid="model-new" {...flowAction(onRunCommand, "model.new")}>New</Button>
  const wantsSession = refresh?.state === "failed" && signInRefused(refresh.failure)
  const alert = <>
    {wantsSession ?
      <div className="flow-run-actions"><Button size="sm" data-testid="models-sign-in" {...flowAction(onRunCommand, "auth.prompt")}>Sign in</Button></div> :
      error === undefined ? null : (
        <FailureNotice className="sui-approval-error" data-testid="models-error"
          failure={refreshFailure(refresh?.state === "failed" ? refresh.failure : undefined, error)}
          actions={{ retry: flowAction(onRunCommand, "model.list") }} />
      )}
  </>
  // "No models." is a fact about a catalog that was read. A catalog this host never answered says nothing about what it holds.
  const empty = host === "observed" ? <p className="world-card-empty" data-testid="models-empty">No models.</p> : null
  if (presentation === "embedded") {
    const attention = attentionOf(card, onRunCommand)
    if (attention !== undefined) return <div className="models-card" data-presentation="embedded">{attention}{alert}</div>
    // The payload lists the host's rows first; the few rows shown here lead with the one just saved or tested, then the user's own, the ones with acts to press.
    const first = [...models.filter((model) => model.id === selected), ...models.filter((model) => model.id !== selected && model.builtin !== true),
      ...models.filter((model) => model.id !== selected && model.builtin === true)]
    return (
      <div className="models-card" data-presentation="embedded">
        {models.length === 0 ? empty : (
          <ul className="workflow-list" data-testid="models-list">
            {first.slice(0, EMBEDDED_ROWS).map((model) => (
              <ModelRow key={model.id} model={model} card={card} onRunCommand={onRunCommand} selected={false} selectable={false} acts />
            ))}
          </ul>
        )}
        {models.length > EMBEDDED_ROWS ? <p className="smithers-card-note" data-testid="models-more">+{models.length - EMBEDDED_ROWS}</p> : null}
        {alert}
        <div className="flow-run-actions">{create}</div>
      </div>
    )
  }
  const current = models.find((model) => model.id === selected) ?? models[0]
  return (
    <div className="models-card models-pane" data-presentation="maximized">
      <div className="models-pane-list">
        {models.length === 0 ? empty : (
          <ul className="workflow-list" data-testid="models-list">
            {models.map((model) => (
              <ModelRow key={model.id} model={model} card={card} onRunCommand={onRunCommand} selected={model.id === current?.id} selectable acts brief />
            ))}
          </ul>
        )}
        <div className="flow-run-actions">{create}</div>
      </div>
      <div className="models-pane-main">
        {current === undefined ? null : <Detail model={current} card={card} onRunCommand={onRunCommand} />}
        <Seats card={card} onRunCommand={onRunCommand} />
        {alert}
      </div>
    </div>
  )
}

/** The composer over the model's live record: whether a Test was recorded is the record's fact, so it is read there, not written to the card. */
const ObservedModelCall = ({ card, models, onRunCommand }: { readonly card: Extract<Card, { kind: "model-call" }>; readonly models: CardProjectionAuthority["collections"]["models"]; readonly onRunCommand: RunCommand }) => {
  const { data } = useLiveQuery(models)
  return <ModelCallCardBody card={card} recall={data.some((row) => row.id === card.payload.model && row.lastTest !== undefined)} onRunCommand={onRunCommand} />
}

export const modelCardFamily: CardFamily<"models" | "model-call"> = {
  models: {
    render: (card, actions) => <ModelsCardBody card={card} onRunCommand={actions.onRunCommand} presentation={actions.presentation ?? "embedded"} />,
    /* Running while a test is out; failed while something needs someone; settled otherwise (the shell hides "done"). */
    pill: (card) => card.payload.testing.length > 0 ? "running" : card.payload.attention !== undefined ? "failed" : "done"
  },
  /* The composer for one model (ModelCallCard.tsx): the same body embedded and maximized. */
  "model-call": {
    render: (card, actions) => actions.projectionStore === undefined
      ? <ModelCallCardBody card={card} recall={false} onRunCommand={actions.onRunCommand} />
      : <ObservedModelCall card={card} models={actions.projectionStore.collections.models} onRunCommand={actions.onRunCommand} />,
    pill: modelCallPill
  }
}
