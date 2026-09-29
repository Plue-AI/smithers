/**
 * Metered proxy rates are generated from the backend modelprice table.
 * @since 1.0.0
 */
import { modelPrices as PRICES } from "../../../../../packages/backend/modelprice/prices.generated.ts";

export type ModelPrice = { input: number; output: number; cacheWrite: number; cacheRead: number };

/** Unknown models fail closed; only exact ids and dated snapshots resolve. */
export function modelPrices(model: string): ModelPrice {
  for (const [key, price] of Object.entries(PRICES)) {
    if (model === key || (model.startsWith(`${key}-`) && /^\d{8}$/.test(model.slice(key.length + 1)))) {
      return { input: price.input, output: price.output, cacheWrite: price.cacheWrite, cacheRead: price.cacheRead };
    }
  }
  throw new Error(`unpriced model: ${model}`);
}
