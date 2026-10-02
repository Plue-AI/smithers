import { paper } from "./themes/paper.ts";
import type { SmithersTheme } from "./SmithersTheme.ts";

export const DEFAULT_THEME_KEY = "paper";

/**
 * `T` with every nested property marked readonly, matching `deepFreeze`.
 *
 * Functions are leaves, and the mapped type over an array preserves tuple keys
 * and arity rather than collapsing to a homogeneous element type.
 */
export type DeepReadonly<T> = T extends (...args: never[]) => unknown ? T
  : T extends readonly unknown[] ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
  : T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
  : T;

/** Every nested plain object and array in `value`, frozen in place. */
function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  }
  return value as DeepReadonly<T>;
}

const registry = { paper } satisfies Record<string, SmithersTheme>;

/**
 * Ordered palette registry used by CSS emitters and widget adapters.
 *
 * Deeply frozen at construction, and typed to match. Two consumers read it on
 * different schedules -- `workflowUiThemeCss` snapshots it at module
 * evaluation, widget adapters read it per render -- so a runtime mutation would
 * give one document two different answers for the same selected theme. Copy
 * before editing; the registry itself never changes.
 */
export const themeRegistry: DeepReadonly<typeof registry> = deepFreeze(registry);

/** A registered `data-palette` value. */
export type ThemeKey = keyof typeof registry;

/** The frozen theme for `key`, or `undefined` when the key is not registered. */
export function findTheme(key: string): DeepReadonly<typeof registry>[ThemeKey] | undefined {
  return Object.hasOwn(registry, key) ? themeRegistry[key as ThemeKey] : undefined;
}
