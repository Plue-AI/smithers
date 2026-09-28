/** @jsxImportSource react */
import {
  type ComponentProps,
  type ComponentType,
  createContext,
  type CSSProperties,
  type ReactNode,
  useContext,
  useId,
  useMemo,
} from "react";
import * as RechartsPrimitive from "recharts";
import { cn } from "../cn";
import { useResolvedTheme } from "../internal/useResolvedTheme";
import { tokens as t } from "../tokens";

/**
 * Chart primitives for Smithers workflow UIs — the shadcn/ui chart contract
 * (`ChartContainer` + `ChartConfig` + tooltip/legend content) ported onto the
 * smithers theme tokens and a CVD-validated categorical palette, over Recharts.
 *
 * It lives in the `adapters/` layer because it pulls the heavy `recharts`
 * widget; reach it through the `@smthrs/ui/adapters/chart`
 * subpath, never the base barrel, which `tests/barrel-weight.test.ts` keeps
 * free of heavy dependencies.
 *
 * House chart rules the defaults encode (see the {@link CHART_SERIES} and
 * {@link chartSeriesColor} doc blocks below):
 * series colors come from {@link chartSeriesColor} in fixed slot order (never
 * cycled or generated), one axis per chart, hairline grid, and identity is
 * never color-alone — the tooltip and legend ship by default, which is also
 * the relief rule for the light-mode slots that sit under 3:1 contrast.
 */

/**
 * The categorical series palette, in fixed slot order. Both columns are one
 * palette — the dark column is the same eight hues re-stepped for the dark
 * surface. Validated (adjacent-pair CVD ΔE ≥ 8, normal-vision ΔE ≥ 15,
 * lightness band, chroma floor) against the smithers light `#fefefe` and dark
 * `#141417` surfaces. Never reorder, cycle, or append generated hues; past
 * eight series fold the tail into "Other" or facet.
 */
export const CHART_SERIES: ReadonlyArray<{ readonly light: string; readonly dark: string; }> = [
  { light: "#2a78d6", dark: "#3987e5" }, // blue
  { light: "#eb6834", dark: "#d95926" }, // orange
  { light: "#1baf7a", dark: "#199e70" }, // aqua
  { light: "#eda100", dark: "#c98500" }, // yellow
  { light: "#e87ba4", dark: "#d55181" }, // magenta
  { light: "#008300", dark: "#008300" }, // green
  { light: "#4a3aa7", dark: "#9085e9" }, // violet
  { light: "#e34948", dark: "#e66767" }, // red
];

/** Series color for a slot index, per theme. Indexes past the palette clamp to the last slot — fold extra series into "Other" instead of reaching it. */
export function chartSeriesColor(index: number, theme: "light" | "dark" = "light"): string {
  const normalizedIndex = Number.isFinite(index) ? Math.trunc(index) : 0;
  const slot = CHART_SERIES[Math.max(0, Math.min(normalizedIndex, CHART_SERIES.length - 1))]!;
  return theme === "dark" ? slot.dark : slot.light;
}

export type ChartConfig = {
  [key: string]: {
    label?: ReactNode;
    icon?: ComponentType;
  } & ({ color?: string; theme?: never; } | { color?: never; theme: { light: string; dark: string; }; });
};

/**
 * Build a {@link ChartConfig} from series keys alone, assigning palette slots
 * in fixed order — the common case for "one config entry per series".
 */
export function chartConfig(series: ReadonlyArray<{ key: string; label?: ReactNode; }>): ChartConfig {
  const config: ChartConfig = {};
  series.forEach((entry, index) => {
    config[entry.key] = {
      label: entry.label ?? entry.key,
      theme: {
        light: chartSeriesColor(index, "light"),
        dark: chartSeriesColor(index, "dark"),
      },
    };
  });
  return config;
}

type ChartContextValue = { config: ChartConfig; };

const ChartContext = createContext<ChartContextValue | null>(null);

function useChart(): ChartContextValue {
  const context = useContext(ChartContext);
  if (!context) throw new Error("useChart must be used within a <ChartContainer />");
  return context;
}

/**
 * Bare config provider for composing {@link ChartTooltipContent} /
 * {@link ChartLegendContent} outside a `<ChartContainer>` (custom overlays,
 * tests). `ChartContainer` uses it internally.
 */
export function ChartProvider({ config, children }: { config: ChartConfig; children: ReactNode; }) {
  const value = useMemo(() => ({ config }), [config]);
  return <ChartContext.Provider value={value}>{children}</ChartContext.Provider>;
}

function configColor(entry: ChartConfig[string] | undefined, theme: "light" | "dark"): string | undefined {
  if (!entry) return undefined;
  if (entry.theme) return entry.theme[theme];
  return entry.color;
}

const CSS_IDENTIFIER = /^[a-zA-Z_][a-zA-Z0-9_-]*$/;
/**
 * The color syntaxes a series may name: hex, a named color, a `var(--token)`,
 * or a color function over plain numbers and keywords. An allowlist, because a
 * denylist of `;{}` still lets `url(...)` or `image-set(...)` through to make
 * the viewer's browser fetch a remote resource.
 */
const SAFE_CSS_COLOR =
  /^(?:#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})|[a-z]+|var\(--[a-z0-9_-]+\)|(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\([0-9a-z.%\s,/+-]*\))$/i;

/**
 * Emits the per-series `--color-<key>` custom properties for the ACTIVE
 * resolved theme (the house adapter convention: `useResolvedTheme` tracks the
 * `data-theme` stamp and the OS scheme, so a toggle re-renders the vars).
 */
function ChartStyle({ id, config }: { id: string; config: ChartConfig; }) {
  const theme = useResolvedTheme();
  const css = useMemo(() => {
    if (!CSS_IDENTIFIER.test(id)) return "";
    const lines = Object.entries(config)
      .map(([key, entry]) => {
        const color = configColor(entry, theme);
        return color && CSS_IDENTIFIER.test(key) && SAFE_CSS_COLOR.test(color)
          ? `  --color-${key}: ${color};`
          : null;
      })
      .filter(Boolean);
    return lines.length > 0 ? `[data-chart="${id}"] {\n${lines.join("\n")}\n}` : "";
  }, [config, id, theme]);
  if (!css) return null;
  return <style dangerouslySetInnerHTML={{ __html: css }} />;
}

/**
 * Recharts chrome, restated in smithers tokens: recessive hairline grid and
 * axes, muted tick text in text tokens (never the series color), surface-color
 * separation instead of mark outlines.
 */
const CHART_CHROME_CSS = [
  '[data-slot="chart"] { display: flex; aspect-ratio: 16 / 9; justify-content: center; font-size: 11px; }',
  '[data-slot="chart"] svg { overflow: visible; }',
  `[data-slot="chart"] .recharts-cartesian-grid line { stroke: ${t.border}; stroke-width: 1; }`,
  `[data-slot="chart"] .recharts-cartesian-axis-line, [data-slot="chart"] .recharts-cartesian-axis-tick-line { stroke: ${t.border}; }`,
  `[data-slot="chart"] .recharts-cartesian-axis-tick text, [data-slot="chart"] .recharts-label { fill: ${t.mutedForeground}; }`,
  `[data-slot="chart"] .recharts-reference-line line { stroke: ${t.border}; }`,
  `[data-slot="chart"] .recharts-curve.recharts-tooltip-cursor { stroke: ${t.border}; }`,
  `[data-slot="chart"] .recharts-rectangle.recharts-tooltip-cursor { fill: ${t.surface2}; }`,
  '[data-slot="chart"] .recharts-layer:focus-visible, [data-slot="chart"] .recharts-sector:focus-visible { outline: none; }',
].join("\n");

export function ChartContainer({
  id,
  className,
  children,
  config,
  ...props
}: ComponentProps<"div"> & {
  config: ChartConfig;
  children: ComponentProps<typeof RechartsPrimitive.ResponsiveContainer>["children"];
}) {
  const uniqueId = useId();
  const chartId = `chart-${id || uniqueId.replace(/:/g, "")}`;
  return (
    <ChartProvider config={config}>
      <div data-slot="chart" data-chart={chartId} className={cn(className)} {...props}>
        <style dangerouslySetInnerHTML={{ __html: CHART_CHROME_CSS }} />
        <ChartStyle id={chartId} config={config} />
        <RechartsPrimitive.ResponsiveContainer>{children}</RechartsPrimitive.ResponsiveContainer>
      </div>
    </ChartProvider>
  );
}

export const ChartTooltip = RechartsPrimitive.Tooltip;

type TooltipItem = {
  dataKey?: string | number;
  name?: string | number;
  value?: number | string;
  color?: string;
  payload?: Record<string, unknown> & { fill?: string; };
};

function itemConfig(config: ChartConfig, item: TooltipItem, fallbackKey?: string): ChartConfig[string] | undefined {
  const key = String(item.dataKey ?? item.name ?? fallbackKey ?? "");
  return config[key];
}

export function ChartTooltipContent({
  active,
  payload,
  className,
  hideLabel = false,
  hideIndicator = false,
  label,
  labelFormatter,
  formatter,
  nameKey,
}: {
  active?: boolean;
  payload?: TooltipItem[];
  className?: string;
  hideLabel?: boolean;
  hideIndicator?: boolean;
  label?: ReactNode;
  labelFormatter?: (label: ReactNode, payload: TooltipItem[]) => ReactNode;
  formatter?: (value: number | string, name: string, item: TooltipItem, index: number) => ReactNode;
  nameKey?: string;
}) {
  const { config } = useChart();
  if (!active || !payload || payload.length === 0) return null;
  const heading = hideLabel ? null : labelFormatter ? labelFormatter(label, payload) : label;
  const wrapper: CSSProperties = {
    display: "grid",
    gap: 6,
    minWidth: 128,
    padding: "8px 10px",
    borderRadius: t.radiusControl,
    border: `1px solid ${t.border}`,
    background: t.popover,
    color: t.foreground,
    fontSize: 12,
    boxShadow: `0 4px 12px rgb(${t.shadowRgb} / 0.12)`,
  };
  return (
    <div data-slot="chart-tooltip" className={className} style={wrapper}>
      {heading != null && heading !== "" ? <div style={{ fontWeight: 600 }}>{heading}</div> : null}
      <div style={{ display: "grid", gap: 4 }}>
        {payload.map((item, index) => {
          const entry = itemConfig(config, item, nameKey);
          const name = entry?.label ?? item.name ?? String(item.dataKey ?? "");
          const indicatorColor = item.color ?? item.payload?.fill;
          return (
            <div
              key={`${String(item.dataKey ?? item.name ?? index)}`}
              style={{ display: "flex", alignItems: "center", gap: 6, justifyContent: "space-between" }}
            >
              <span style={{ display: "flex", alignItems: "center", gap: 6, color: t.mutedForeground }}>
                {hideIndicator ? null : (
                  <span
                    aria-hidden
                    style={{ width: 8, height: 8, borderRadius: 2, background: indicatorColor, flexShrink: 0 }}
                  />
                )}
                {name}
              </span>
              {formatter && item.value !== undefined ?
                (
                  formatter(item.value, String(name), item, index)
                ) :
                (
                  <span style={{ fontVariantNumeric: "tabular-nums", fontWeight: 600 }}>
                    {typeof item.value === "number" ? item.value.toLocaleString() : item.value}
                  </span>
                )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export const ChartLegend = RechartsPrimitive.Legend;

export function ChartLegendContent({
  payload,
  className,
  nameKey,
}: {
  payload?: ReadonlyArray<{ value?: string | number; dataKey?: string | number; color?: string; }>;
  className?: string;
  nameKey?: string;
}) {
  const { config } = useChart();
  if (!payload || payload.length === 0) return null;
  return (
    <div
      data-slot="chart-legend"
      className={className}
      style={{
        display: "flex",
        flexWrap: "wrap",
        justifyContent: "center",
        gap: "4px 16px",
        paddingTop: 8,
        fontSize: 12,
        color: t.mutedForeground,
      }}
    >
      {payload.map((item, index) => {
        const key = String(item.dataKey ?? nameKey ?? item.value ?? index);
        const entry = config[key] ?? config[String(item.value ?? "")];
        return (
          <span key={key} style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span aria-hidden style={{ width: 8, height: 8, borderRadius: 2, background: item.color, flexShrink: 0 }} />
            {entry?.label ?? item.value}
          </span>
        );
      })}
    </div>
  );
}
