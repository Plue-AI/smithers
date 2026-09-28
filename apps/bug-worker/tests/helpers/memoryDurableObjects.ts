import type { State } from "../../src/durableState.ts";
import { RateLimiter } from "../../src/RateLimiter.ts";
import { RepoCompletion } from "../../src/RepoCompletion.ts";

type Namespace = { getByName(name: string): { fetch(request: Request): Promise<Response> } };

/** Runs a deployed Durable Object class against isolated, atomic, rollback-capable storage per name. */
function memoryDurableObjects(make: (state: State) => { fetch(request: Request): Promise<Response> }): Namespace {
  const stores = new Map<string, { values: Map<string, unknown>; tail: Promise<unknown> }>();
  return {
    getByName(name) {
      let store = stores.get(name);
      if (!store) {
        store = { values: new Map(), tail: Promise.resolve() };
        stores.set(name, store);
      }
      const state = store;
      // Construct afresh on every access so tests cannot rely on instance memory.
      return make({ storage: {
        transaction(callback) {
          const result = state.tail.then(async () => {
            const pending = structuredClone(state.values);
            const value = await callback({
              async get<T>(key: string) { return structuredClone(pending.get(key)) as T | undefined; },
              async put<T>(key: string, value: T) { pending.set(key, structuredClone(value)); },
            });
            state.values = pending;
            return value;
          });
          state.tail = result.catch(() => {});
          return result;
        },
      } });
    },
  };
}

export const memoryRepoCompletions = () => memoryDurableObjects((state) => new RepoCompletion(state));
export const memoryRateLimits = () => memoryDurableObjects((state) => new RateLimiter(state));
