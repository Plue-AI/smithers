/**
 * Metered proxy rates are generated from the backend modelprice table.
 * @since 1.0.0
 */
import { modelPrices as PRICES } from "../../../../../packages/smithers/agent/model/src/internal/prices.generated.ts";

export type ModelPrice = { input: number; output: number; cacheWrite: number; cacheRead: number };

export interface ModelPriceOptions {
  /**
   * Total prompt tokens (input plus cache write and cache read). From
   * `longContextFrom` the long-context card prices the whole call.
   */
  promptTokens?: number;
  /** The instant whose price applies, epoch milliseconds; defaults to now. A dated successor applies from its `nextFrom`. */
  at?: number;
}

/** Unknown models fail closed; only exact ids and dated snapshots resolve. */
export function modelPrices(model: string, options: ModelPriceOptions = {}): ModelPrice {
  for (const [key, row] of Object.entries(PRICES)) {
    if (model === key || (model.startsWith(`${key}-`) && /^\d{8}$/.test(model.slice(key.length + 1)))) {
      let price = row;
      const at = options.at ?? Date.now();
      // An undated successor never starts.
      while (price.next !== undefined && at >= Date.parse(String(price.nextFrom))) price = price.next;
      const rates =
        price.longContext !== undefined && (options.promptTokens ?? 0) >= Number(price.longContextFrom)
          ? price.longContext
          : price;
      return { input: rates.input, output: rates.output, cacheWrite: rates.cacheWrite, cacheRead: rates.cacheRead };
    }
  }
  throw new Error(`unpriced model: ${model}`);
}
