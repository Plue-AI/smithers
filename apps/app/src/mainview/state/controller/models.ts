/** Resolve previously configured host model bindings without exposing a model laboratory. */
import type { ConfiguredModel, ModelBinding, SeatId } from "@smthrs/rpc/ConfiguredModel"
import { bindingOf, seatAccepts } from "@smthrs/rpc/ConfiguredModel"
import type { StoredModel } from "../AppState"
import type { AppStore } from "../AppStore"

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

