import { MODEL_CATALOG_PATH,MODEL_DEFAULT_PATH,MODEL_TEST_PATH } from "@smthrs/rpc/AgentApiRoutes"
import { hasCapability } from "@smthrs/rpc/AppBootstrap"
import type { ConfiguredModel,ModelBinding,ModelCallInput,ModelCatalog,ModelProtocol,ModelTestFailure,ModelTestResult,SeatId } from "@smthrs/rpc/ConfiguredModel"
import {
  ConfiguredModelSchema,MODEL_PROTOCOL_DEFAULTS,MODEL_SEAT_DEFAULT,ModelCatalogSchema,ModelTestResultSchema,SeatIdSchema,
  bindingOf,hostRefusedModelTest,modelOriginOf,modelSeat,modelTestFixOf,planModelBinding,seatAccepts
} from "@smthrs/rpc/ConfiguredModel"
import { clientRefusal,refusalOf } from "@smthrs/rpc/Refusal"
import type { CommandResult } from "../../flows/entries/Declare"
import type { FieldOption } from "@smthrs/ui/flow-form"
import { flag,line } from "@smthrs/ui/flow-form"
import { actorSharedState } from "../ActorBindings"
import type { Card,StoredModel } from "../AppState"
import type { AppStore } from "../AppStore"
import type { ControllerContext } from "./context"
import { TOAST_SUPERSEDED } from "./failures"
import { formRenderedText,type FormsController } from "./forms"

export const MODELS_CARD_ID = "models"

type ModelsCard = Extract<Card, { kind: "models" }>
type ModelsPayload = ModelsCard["payload"]
type Attention = NonNullable<ModelsPayload["attention"]>

/** `model.save`'s input: the form's fields, where `name` becomes the record's id. */
export interface SaveModelInput {
  readonly name: string
  readonly protocol: ModelProtocol
  readonly modelId: string
  readonly credential: string
  readonly baseUrl?: string | undefined
  readonly path?: string | undefined
}

export interface ModelsController {
  /** `model.list`: requested at once; the persisted refresh and its toast run in the background. */
  readonly listModels: () => Promise<CommandResult>
  /** `model.show <name>`: the card's selected row. */
  readonly showModel: (id: string) => CommandResult
  /** `model.new`: the `model.save` form, empty. */
  readonly newModel: () => CommandResult
  /** `model.edit <name>`: the `model.save` form, prefilled. A host row is refused. */
  readonly editModel: (id: string) => CommandResult
  readonly saveModel: (input: SaveModelInput) => Promise<CommandResult>
  readonly removeModel: (id: string) => Promise<CommandResult>
  /** `model.test <name>`: requested at once; the call, its toast and its result are background work. */
  readonly testModel: (id: string) => Promise<CommandResult>
  /** `model.assign <seat> <name|default>`. */
  readonly assignSeat: (seat: string, recordId: string) => Promise<CommandResult>
  readonly credentialMissing: () => void
  /** After identity loads: reconnect every requested test and catalog refresh. Idempotent. */
  readonly resumeModels: () => void
  /** Boot: reads the catalog only when a seat is assigned and the host can serve it. */
  readonly observeModels: () => Promise<void>
}

export interface ModelsControllerDependencies {
  readonly nextOrdinal: () => number
  readonly renderFlowForm: FormsController["renderFlowForm"]
  /** The frames controller's: it also moves the address bar back to the root frame. */
  readonly minimizeCard: () => void
}

/** The record alone, field by field: a live row also carries its last test and the collection's own sync metadata. */
const recordOf = (row: StoredModel): ConfiguredModel =>
  ({ id: row.id, ...bindingOf(row), ...(row.builtin === true ? { builtin: true } : {}) })

/** Every assignment a request may carry: the record still exists and is of the seat's kind. */
export const resolvedSeats = (
  store: Pick<AppStore, "collections">
): ReadonlyArray<{ readonly seat: SeatId; readonly model: ConfiguredModel }> =>
  [...store.collections.seats.values()].flatMap((row) => {
    const record = store.collections.models.get(row.recordId)
    return record === undefined || !seatAccepts(row.id, record.protocol) ? [] : [{ seat: row.id, model: recordOf(record) }]
  }).sort((left, right) => left.seat.localeCompare(right.seat))

/** What one seat's request carries; undefined leaves the host's default to answer. */
export const seatBinding = (store: Pick<AppStore, "collections">, seat: SeatId): ModelBinding | undefined => {
  const resolved = resolvedSeats(store).find((row) => row.seat === seat)
  return resolved === undefined ? undefined : bindingOf(resolved.model)
}

/** A failure as the row and the toast state it: the code and its number or name. No sentence. */
export const modelFailureLine = (failure: ModelTestFailure): string => {
  switch (failure.code) {
    case "refused": return `${failure.code} · ${failure.status}`
    // The deadline the host armed, read from the record.
    case "timeout": return `${failure.code} · ${failure.deadlineMs} ms`
    case "invalid": return `${failure.code} · ${failure.field}`
    case "credential_missing":
    case "credential_unknown": return `${failure.code} · ${failure.credential}`
    case "host_refused": {
      const detail = failure.refusal ?? failure.status
      return detail === null ? failure.code : `${failure.code} · ${detail}`
    }
    case "unreachable":
    case "empty_output":
    case "endpoint_forbidden":
    case "model_not_allowed": return failure.code
  }
}

/** The credential picker's options: the names the host listed. */
export const credentialOptions = (catalog: Pick<ModelCatalog, "credentials"> | undefined): FieldOption[] =>
  (catalog?.credentials ?? []).map(row => ({ value: row.name, label: row.name, ...(row.present ? {} : { disabled: true, reason: "missing" }) }))

/**
 * One call to the host's test route, as a result either way: a refusal to run
 * it, or silence, is typed here. With no input the host runs its fixed Test;
 * the composer (modelCall.ts) sends the request a person composed.
 */
export const callModelTest = async (ctx: Pick<ControllerContext, "baseUrl" | "boundedFetch">, model: ConfiguredModel, input?: ModelCallInput): Promise<ModelTestResult> => {
  const startedAt = Date.now()
  let response: Response
  try {
    response = await ctx.boundedFetch(`${ctx.baseUrl}${MODEL_TEST_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input === undefined ? { model } : { model, input })
    })
  } catch (cause) {
    // The refusal's fault and status are kept; nobody's words are.
    return hostRefusedModelTest(clientRefusal(cause, ""), Date.now() - startedAt)
  }
  const body: unknown = await response.json().catch((): undefined => undefined)
  const latencyMs = Date.now() - startedAt
  if (!response.ok) return hostRefusedModelTest(refusalOf({ body, status: response.status, message: "" }), latencyMs)
  const decoded = ModelTestResultSchema.safeParse(body)
  // A 200 this build cannot read is nobody's mistake but ours.
  return decoded.success ? decoded.data : hostRefusedModelTest({ code: null, status: response.status, fault: "bug" }, latencyMs)
}

/** One test in flight, for one account. A newer launch of an edited route, or for the account that arrived, replaces it, and only the current one may write. */
interface Flight { readonly route: string; readonly epoch: number }
interface CatalogFlight { readonly epoch: number; work: Promise<unknown> }

export const createModelsController = (ctx: ControllerContext, deps: ModelsControllerDependencies): ModelsController => {
  const { store } = ctx
  const { collections } = store
  /*
   * The user's and the agent's bindings are two closures over one controller
   * lifetime: the host's last answer and the tests in flight belong to both, so
   * a test the agent launched is the one the human's second press joins.
   */
  const shared = actorSharedState(ctx, "models", (): {
    epoch: number; catalog: ModelCatalog | undefined; refresh: ModelsPayload["refresh"]; catalogFlight: CatalogFlight | undefined; flights: Map<string, Flight>; requested: Set<string>
  } => {
    const saved = collections.cards.get(MODELS_CARD_ID)
    return { epoch: ctx.accountEpoch, catalog: undefined, refresh: saved?.kind === "models" ? saved.payload.refresh : undefined, catalogFlight: undefined,
      flights: new Map(), requested: new Set(saved?.kind === "models" ? saved.payload.testing : []) }
  })

  const card = (): ModelsCard | undefined => {
    const row = collections.cards.get(MODELS_CARD_ID)
    return row?.kind === "models" ? row : undefined
  }

  const syncAccount = (): void => {
    if (shared.epoch === ctx.accountEpoch) return
    shared.epoch = ctx.accountEpoch
    shared.catalog = undefined
    shared.refresh = card()?.payload.refresh
  }

  /** The card from the two collections, the host's last answer, and what a reload kept of it. */
  const payload = (attention: Attention | undefined, selected?: string): ModelsPayload => {
    syncAccount()
    const existing = card()?.payload
    const rows = [...collections.models.values()]
      .sort((left, right) => Number(right.builtin === true) - Number(left.builtin === true) || left.id.localeCompare(right.id))
    const credentials = shared.catalog?.credentials ?? existing?.credentials ?? []
    const present = new Set(credentials.filter((row) => row.present).map((row) => row.name))
    const seats = (shared.catalog?.seats ?? existing?.seats.map((seat) => seat.id) ?? []).map((id) => {
      const recordId = collections.seats.get(id)?.recordId ?? null
      const record = recordId === null ? undefined : collections.models.get(recordId)
      // With no credential list there is nothing to judge a name against.
      const resolvable = recordId === null || (record !== undefined && seatAccepts(id, record.protocol) &&
        (credentials.length === 0 || present.has(record.credential)))
      return { id, recordId, resolvable }
    })
    const chosen = selected ?? existing?.selected
    return {
      models: rows.map(recordOf),
      seats,
      credentials: [...credentials],
      tests: rows.flatMap((row) => row.lastTest === undefined ? [] : [row.lastTest]),
      testing: [...shared.requested].filter((id) => collections.models.has(id)).sort(),
      host: shared.catalog === undefined ? "unavailable" : "observed",
      ...(chosen !== undefined && collections.models.get(chosen) !== undefined ? { selected: chosen } : {}),
      ...(attention === undefined ? {} : { attention }),
      ...(shared.refresh === undefined ? {} : { refresh: shared.refresh }),
      ...(shared.refresh?.state === "failed" ? { error: modelFailureLine(shared.refresh.failure) } : {})
    }
  }

  /** The first assigned seat this host cannot answer from its record. */
  const unresolved = (): Attention | undefined => {
    const seat = payload(undefined).seats.find((row) => !row.resolvable)
    return seat === undefined ? undefined : { kind: "seat-unresolved", seat: seat.id }
  }

  /** What the card surfaced for stays while it is still true, so background work never talks over it. */
  const standing = (): Attention | undefined => {
    const attention = card()?.payload.attention
    if (attention === undefined) return undefined
    if (attention.kind === "seat-unresolved") return unresolved()
    const failed = collections.models.get(attention.recordId)?.lastTest?.result.ok === false
    return failed && !shared.flights.has(attention.recordId) ? attention : undefined
  }

  /** At the tail when someone asked or the attention is new, never moving a maximized card; in place otherwise, and a no-op with no card. */
  const render = (actor: "user" | "smithers" | "system", toTail: boolean, attention: Attention | undefined, selected?: string): Promise<unknown> | undefined => {
    const existing = card()
    if (!toTail && existing === undefined) return
    const moves = existing === undefined || (toTail && store.session().maximizedCardId !== MODELS_CARD_ID)
    return store.dispatch({
      type: "card.upsert",
      actor,
      card: {
        id: MODELS_CARD_ID,
        kind: "models",
        title: "Models",
        status: "active",
        createdAt: existing?.createdAt ?? Date.now(),
        ordinal: moves ? deps.nextOrdinal() : existing.ordinal,
        payload: payload(attention, selected)
      }
    }).isPersisted.promise
  }

  /** Unasked surfacing: the card comes to the tail once per attention, and is refreshed in place after that. */
  const raise = (attention: Attention): void => {
    render("system", JSON.stringify(card()?.payload.attention) !== JSON.stringify(attention), attention)
  }

  /** The catalog or a typed host refusal; no provider prose is stored. */
  const callCatalog = async (): Promise<{ readonly ok: true; readonly catalog: ModelCatalog } | Extract<ModelTestResult, { ok: false }>> => {
    let response: Response
    try {
      response = await ctx.boundedFetch(`${ctx.baseUrl}${MODEL_CATALOG_PATH}`)
    } catch (cause) {
      return hostRefusedModelTest(clientRefusal(cause, ""), 0)
    }
    const body: unknown = await response.json().catch((): undefined => undefined)
    const decoded = response.ok ? ModelCatalogSchema.safeParse(body) : undefined
    if (decoded?.success !== true) {
      return hostRefusedModelTest(response.ok
        ? { ...clientRefusal(undefined, ""), fault: "bug", status: response.status }
        : refusalOf({ body, status: response.status, message: "" }), 0)
    }
    return { ok: true, catalog: decoded.data }
  }

  const refreshCredentialForms = (catalog: ModelCatalog): void => {
    for (const form of [...collections.cards.values()]) if (form.kind === "flow-form" && form.status !== "acted") {
      if (!form.payload.fields.some(field => field.optionsFrom === "credentials")) continue
      const fields = form.payload.fields.map(field => field.optionsFrom === "credentials" ? { ...field, options: credentialOptions(catalog) } : field)
      store.dispatch({ type: "card.upsert", actor: "system", card: { ...form, payload: { ...form.payload, fields } } })
    }
  }

  const refreshCatalog = (toTail: boolean): Promise<unknown> => {
    syncAccount()
    if (shared.catalogFlight?.epoch === ctx.accountEpoch) {
      if (toTail) render(ctx.commandActor, true, undefined)
      return shared.catalogFlight.work
    }
    const flight: CatalogFlight = { epoch: ctx.accountEpoch, work: Promise.resolve() }
    shared.catalogFlight = flight
    shared.refresh = { state: "requested" }
    const persisted = render(toTail ? ctx.commandActor : "system", toTail || card() === undefined, toTail ? undefined : standing())
    const owns = () => !ctx.disposed && ctx.accountEpoch === flight.epoch && shared.catalogFlight === flight
    flight.work = ctx.withToast("model.list", "Loading models…", "Models loaded", async () => {
      await persisted
      if (!owns()) return TOAST_SUPERSEDED
      const result = await callCatalog()
      if (!owns()) return TOAST_SUPERSEDED
      shared.catalog = result.ok ? result.catalog : undefined
      shared.refresh = result.ok ? undefined : { state: "failed", failure: result.failure }
      if (result.ok) {
        await store.dispatch({ type: "models.observed", actor: "system", models: result.catalog.models }).isPersisted.promise
        refreshCredentialForms(result.catalog)
      }
      if (!owns()) return TOAST_SUPERSEDED
      const attention = unresolved() ?? standing()
      await render("system", attention !== undefined && JSON.stringify(card()?.payload.attention) !== JSON.stringify(attention), attention)
      return result.ok ? true : modelFailureLine(result.failure)
    }).then((outcome) => {
      if (shared.catalogFlight !== flight) return
      shared.catalogFlight = undefined
      if (typeof outcome === "string" && !ctx.disposed && ctx.accountEpoch === flight.epoch) {
        ctx.resolveToast("model.list", { status: "failed", detail: outcome, action: { flow: "model.list", label: "Retry" } })
      }
    })
    return flight.work
  }

  const listModels: ModelsController["listModels"] = async () => {
    void refreshCatalog(true)
    return { value: "Requested" }
  }

  const missing = (id: string): string => `There is no model ${id}.`

  const showModel: ModelsController["showModel"] = (id) => {
    if (collections.models.get(id) === undefined) return missing(id)
    render(ctx.commandActor, card() === undefined, unresolved(), id)
  }

  const openForm = (args: string | undefined): CommandResult => {
    const form = deps.renderFlowForm({ name: "model.save", args, via: ctx.commandActor === "smithers" ? "agent" : "user" })
    if (form === undefined) return "The model form is unavailable."
    // The form is a card in the transcript; the pane would cover it. Presentation is the user's, so an agent's form waits behind it.
    if (ctx.commandActor !== "smithers" && store.session().maximizedCardId === MODELS_CARD_ID) deps.minimizeCard()
    return { value: formRenderedText(form.missing) }
  }

  const newModel: ModelsController["newModel"] = () => {
    if (shared.catalog === undefined) void refreshCatalog(false)
    return openForm(undefined)
  }

  const editModel: ModelsController["editModel"] = (id) => {
    const record = collections.models.get(id)
    if (record === undefined) return missing(id)
    if (record.builtin === true) return `${id} is the host's. Save a copy under another name.`
    const given = { ...record, name: record.id }
    return openForm(line(flag(given, "name"), flag(given, "protocol"), flag(given, "modelId", "model"), flag(given, "credential"),
      flag(given, "baseUrl", "url"), flag(given, "path")))
  }

  const saveModel: ModelsController["saveModel"] = async (input) => {
    const name = input.name.trim(), baseUrl = input.baseUrl?.trim() ?? "", path = input.path?.trim() ?? ""
    // The host's names are the host's: a record under one would be shadowed by the next catalog.
    if (collections.models.get(name)?.builtin === true) return "invalid · name"
    const decoded = ConfiguredModelSchema.safeParse({ id: name, protocol: input.protocol, modelId: input.modelId.trim(), credential: input.credential.trim(),
      ...(baseUrl === "" ? {} : { baseUrl }), ...(path === "" ? {} : { path }) })
    if (!decoded.success) {
      const field = String(decoded.error.issues[0]?.path[0] ?? "model")
      return `invalid · ${field === "id" ? "name" : field}`
    }
    const model = decoded.data
    /*
     * The shape rules a form cannot express (openai-chat needs a base URL, a
     * path belongs to openai-chat) are the planner's. It runs over a table that
     * pins this record's own origin, so only a shape failure can come back:
     * whether the host pins that origin, and holds the credential, is the
     * host's to say when the model is tested.
     */
    const origin = modelOriginOf(model.baseUrl ?? MODEL_PROTOCOL_DEFAULTS[model.protocol].baseUrl)
    const planned = planModelBinding(bindingOf(model), [{ name: model.credential, present: true, origins: origin === undefined ? [] : [origin] }])
    if (!planned.ok && planned.failure.code === "invalid") return modelFailureLine(planned.failure)
    await store.dispatch({ type: "model.saved", actor: ctx.commandActor, model }).isPersisted.promise
    render(ctx.commandActor, card() === undefined, unresolved(), model.id)
    return { value: `saved ${model.id}` }
  }

  const removeModel: ModelsController["removeModel"] = async (id) => {
    const record = collections.models.get(id)
    if (record === undefined) return missing(id)
    if (record.builtin === true) return `${id} is the host's and cannot be removed.`
    await store.dispatch({ type: "model.removed", actor: ctx.commandActor, id }).isPersisted.promise
    render(ctx.commandActor, false, unresolved())
  }

  const assignSeat: ModelsController["assignSeat"] = async (seatText, recordText) => {
    const seat = SeatIdSchema.safeParse(seatText.trim())
    if (!seat.success) return `There is no seat ${seatText}.`
    const { label, kind } = modelSeat(seat.data)
    if (shared.catalog !== undefined && !shared.catalog.seats.includes(seat.data)) return `This host has no ${label} seat.`
    const recordId = recordText.trim()
    const record = recordId === MODEL_SEAT_DEFAULT ? undefined : collections.models.get(recordId)
    if (recordId !== MODEL_SEAT_DEFAULT && record === undefined) return missing(recordId)
    if (record !== undefined && !seatAccepts(seat.data, record.protocol)) return `${label} takes a ${kind} model.`
    if (seat.data === "chat") {
      try {
        const response = await ctx.boundedFetch(`${ctx.baseUrl}${MODEL_DEFAULT_PATH}`, { method: "PUT", headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: record === undefined ? null : bindingOf(record) }) })
        if (!response.ok) return "Chat model could not be saved."
      } catch { return "Chat model could not be saved." }
    }
    if (recordId === MODEL_SEAT_DEFAULT) {
      await store.dispatch({ type: "seat.assigned", actor: ctx.commandActor, seat: seat.data, recordId: null }).isPersisted.promise
    } else {
      await store.dispatch({ type: "seat.assigned", actor: ctx.commandActor, seat: seat.data, recordId }).isPersisted.promise
    }
    render(ctx.commandActor, card() === undefined, unresolved())
  }

  const credentialMissing: ModelsController["credentialMissing"] = () => {
    const assigned = collections.seats.get("chat")?.recordId
    const record = assigned === undefined || assigned === null ? undefined : collections.models.get(assigned)
    if (record === undefined) { void refreshCatalog(true); return }
    void store.dispatch({ type: "model.tested", actor: "system", test: { id: record.id, testedAt: Date.now(),
      result: { ok: false, latencyMs: 0, failure: { code: "credential_missing", credential: record.credential }, fault: "user" } } }).isPersisted.promise
      .then(() => raise({ kind: "test-failed", recordId: record.id }))
  }

  /** The background half. Never awaited by the command that asked for it. */
  const launch = (model: ConfiguredModel): void => {
    const { id } = model
    const epoch = ctx.accountEpoch
    const flight: Flight = { route: JSON.stringify(bindingOf(model)), epoch }
    shared.flights.set(id, flight)
    shared.requested.add(id)
    const key = `model.test:${id}`
    void ctx.withToast(key, `Testing ${id}…`, `Tested ${id}`, async () => {
      const result = await callModelTest(ctx, model)
      // A newer launch of an edited route owns the id now; this answer is about a route that is gone.
      if (shared.flights.get(id) !== flight) return TOAST_SUPERSEDED
      shared.flights.delete(id)
      shared.requested.delete(id)
      if (ctx.disposed) return TOAST_SUPERSEDED
      const record = collections.models.get(id)
      if (ctx.accountEpoch !== epoch || record === undefined || JSON.stringify(bindingOf(record)) !== flight.route) {
        render("system", false, standing())
        return TOAST_SUPERSEDED
      }
      await store.dispatch({ type: "model.tested", actor: "system", test: { id, testedAt: Date.now(), result } }).isPersisted.promise
      if (result.ok) {
        render("system", false, standing())
        return true
      }
      // A failure inside the toast debounce shows no toast at all, so the card is what keeps it visible.
      raise({ kind: "test-failed", recordId: id })
      return modelFailureLine(result.failure)
    }).then((outcome) => {
      // The failed toast carries the card's one fix, chosen as the card chooses it.
      const record = collections.models.get(id)
      if (typeof outcome !== "string" || ctx.disposed || shared.flights.has(id) || record === undefined) return
      const retry = modelTestFixOf(record.builtin === true, record.lastTest?.result) === "test"
      ctx.resolveToast(key, { status: "failed", detail: outcome, action: { flow: retry ? "model.test" : "model.edit", args: id, label: retry ? "Test" : "Edit" } })
    })
  }

  const testModel: ModelsController["testModel"] = async (id) => {
    const record = collections.models.get(id)
    if (record === undefined) return missing(id)
    const model = recordOf(record)
    // Duplicate input joins the test already out; an edited route, or another account's test, is a different test.
    const current = shared.flights.get(id)
    if (current?.route !== JSON.stringify(bindingOf(model)) || current.epoch !== ctx.accountEpoch) {
      launch(model)
      // The request is on the card, and so on disk, before any answer can be.
      render(ctx.commandActor, card() === undefined, standing(), id)
    }
    return { value: "Requested" }
  }

  const resumeModels: ModelsController["resumeModels"] = () => {
    syncAccount()
    const requested = card()?.payload.testing ?? []
    // A test is idempotent, so a persisted request is launched again rather than forgotten.
    for (const id of requested) {
      const record = collections.models.get(id)
      if (record !== undefined && shared.flights.get(id)?.epoch !== ctx.accountEpoch) launch(recordOf(record))
      if (record === undefined) shared.requested.delete(id)
    }
    // A request whose model is gone leaves the card.
    if (requested.some((id) => !shared.flights.has(id))) render("system", false, standing())
    if (shared.refresh?.state === "requested") void refreshCatalog(false)
  }

  const observeModels: ModelsController["observeModels"] = async () => {
    const { bootstrap } = ctx.services
    // A user who never assigned a seat pays nothing at boot.
    if (collections.seats.size === 0 || bootstrap === undefined ||
      !(hasCapability(bootstrap, "agent") || hasCapability(bootstrap, "model.turn"))) return
    await refreshCatalog(false)
  }

  return { listModels, showModel, newModel, editModel, saveModel, removeModel, testModel, assignSeat, credentialMissing, resumeModels, observeModels }
}
