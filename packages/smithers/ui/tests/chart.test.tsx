// Chart adapter under renderToStaticMarkup: recharts does not paint without a
// measured container, so these tests assert the parsed model — palette slots,
// CSS-var wiring, and the tooltip/legend content components — the same
// convention as the other heavy-widget adapters.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Bar, BarChart } from "recharts";
import {
  CHART_SERIES,
  chartConfig,
  ChartContainer,
  ChartLegendContent,
  ChartProvider,
  chartSeriesColor,
  ChartTooltipContent,
} from "../src/adapters/chart";

describe("chart palette", () => {
  test("series slots are assigned in fixed order and clamp past the palette", () => {
    expect(chartSeriesColor(0, "light")).toBe("#2a78d6");
    expect(chartSeriesColor(0, "dark")).toBe("#3987e5");
    expect(chartSeriesColor(1, "light")).toBe("#eb6834");
    expect(chartSeriesColor(99, "light")).toBe(CHART_SERIES.at(-1)!.light);
    expect(chartSeriesColor(-1, "light")).toBe(CHART_SERIES[0]!.light);
  });

  test("normalizes non-finite and fractional palette indexes in both themes", () => {
    const cases: ReadonlyArray<readonly [number, number]> = [
      [Number.NaN, 0],
      [Number.POSITIVE_INFINITY, 0],
      [Number.NEGATIVE_INFINITY, 0],
      [-1, 0],
      [0, 0],
      [7, 7],
      [8, 7],
      [2.9, 2],
    ];

    for (const [input, slot] of cases) {
      expect(chartSeriesColor(input, "light")).toBe(CHART_SERIES[slot]!.light);
      expect(chartSeriesColor(input, "dark")).toBe(CHART_SERIES[slot]!.dark);
    }
  });

  test("chartConfig maps keys to palette slots in order with both theme steps", () => {
    const config = chartConfig([{ key: "landed", label: "Landed" }, { key: "inflight" }]);
    expect(config.landed).toMatchObject({ label: "Landed", theme: { light: "#2a78d6", dark: "#3987e5" } });
    expect(config.inflight).toMatchObject({ label: "inflight", theme: { light: "#eb6834", dark: "#d95926" } });
  });
});

describe("<ChartContainer>", () => {
  test("renders the chart slot with per-series CSS vars and recessive chrome", () => {
    const config = chartConfig([{ key: "commits" }, { key: "files" }]);
    const html = renderToStaticMarkup(
      <ChartContainer id="release" config={config}>
        <BarChart width={400} height={200} data={[{ area: "ui", commits: 4, files: 9 }]}>
          <Bar dataKey="commits" fill="var(--color-commits)" />
        </BarChart>
      </ChartContainer>,
    );
    expect(html).toContain('data-slot="chart"');
    expect(html).toContain('data-chart="chart-release"');
    // Server render resolves the light theme; the vars carry the palette slots.
    expect(html).toContain("--color-commits: #2a78d6");
    expect(html).toContain("--color-files: #eb6834");
    // Recessive chrome restated in tokens, never series color on text.
    expect(html).toContain(".recharts-cartesian-axis-tick text");
  });

  test("omits unsafe config keys and color values from generated CSS", () => {
    const config: Parameters<typeof ChartContainer>[0]["config"] = {
      safe_key: { color: "rgb(42 120 214 / 0.8)" },
      ["bad};body"]: { color: "red" },
      badColor: { color: "red; } body { color: red" },
      styleClose: { color: "</style><style>body{color:red}" },
    };
    const html = renderToStaticMarkup(
      <ChartContainer id="security" config={config}>
        <BarChart width={400} height={200} data={[]}>
          <Bar dataKey="safe_key" fill="var(--color-safe_key)" />
        </BarChart>
      </ChartContainer>,
    );

    expect(html).toContain("--color-safe_key: rgb(42 120 214 / 0.8);");
    expect(html).not.toContain("--color-bad");
    expect(html).not.toContain("--color-styleClose");
    expect(html).not.toContain("bad};body");
  });

  test("admits only color syntax, never a remote fetch", () => {
    const config: Parameters<typeof ChartContainer>[0]["config"] = {
      hex: { color: "#2a78d6" },
      named: { color: "rebeccapurple" },
      token: { color: "var(--chart-1)" },
      oklch: { color: "oklch(0.7 0.1 250 / 50%)" },
      remote: { color: "url(https://attacker.example/x)" },
      imageSet: { color: 'image-set("https://attacker.example/x" 1x)' },
      nested: { color: "rgb(var(--x, url(https://attacker.example/x)))" },
      escaped: { color: "u\\72l(https://attacker.example/x)" },
    };
    const html = renderToStaticMarkup(
      <ChartContainer id="fetch" config={config}>
        <BarChart width={400} height={200} data={[]}>
          <Bar dataKey="hex" fill="var(--color-hex)" />
        </BarChart>
      </ChartContainer>,
    );

    expect(html).toContain("--color-hex: #2a78d6;");
    expect(html).toContain("--color-named: rebeccapurple;");
    expect(html).toContain("--color-token: var(--chart-1);");
    expect(html).toContain("--color-oklch: oklch(0.7 0.1 250 / 50%);");
    expect(html).not.toContain("attacker.example");
    expect(html).not.toContain("--color-remote");
    expect(html).not.toContain("--color-imageSet");
    expect(html).not.toContain("--color-nested");
    expect(html).not.toContain("--color-escaped");
  });

  test("does not interpolate an unsafe chart id into the style block", () => {
    const unsafeId = 'release</style><script data-xss="">owned</script><style>';
    const html = renderToStaticMarkup(
      <ChartContainer id={unsafeId} config={chartConfig([{ key: "safe" }])}>
        <BarChart width={400} height={200} data={[]}>
          <Bar dataKey="safe" fill="var(--color-safe)" />
        </BarChart>
      </ChartContainer>,
    );

    expect(html.match(/<style/g) ?? []).toHaveLength(1);
    expect(html).not.toContain("<script data-xss");
    expect(html).not.toContain("--color-safe");
  });
});

describe("<ChartTooltipContent>", () => {
  const config = chartConfig([
    { key: "landed", label: "Landed" },
    { key: "inflight", label: "In flight" },
  ]);

  test("renders config labels, indicator swatches, and formatted values", () => {
    const html = renderToStaticMarkup(
      <ChartProvider config={config}>
        <ChartTooltipContent
          active
          label="critical"
          payload={[
            { dataKey: "landed", value: 1234, color: "#2a78d6" },
            { dataKey: "inflight", value: 2, color: "#eb6834" },
          ]}
        />
      </ChartProvider>,
    );
    expect(html).toContain("Landed");
    expect(html).toContain("In flight");
    expect(html).toContain("1,234");
    expect(html).toContain("background:#2a78d6");
    expect(html).toContain("critical");
  });

  test("renders nothing when inactive or empty", () => {
    const idle = renderToStaticMarkup(
      <ChartProvider config={config}>
        <ChartTooltipContent active={false} payload={[{ dataKey: "landed", value: 1 }]} />
      </ChartProvider>,
    );
    expect(idle).toBe("");
    const empty = renderToStaticMarkup(
      <ChartProvider config={config}>
        <ChartTooltipContent active payload={[]} />
      </ChartProvider>,
    );
    expect(empty).toBe("");
  });

  test("throws outside a chart provider", () => {
    expect(() => renderToStaticMarkup(<ChartTooltipContent active payload={[{ value: 1 }]} />)).toThrow(
      "useChart must be used within a <ChartContainer />",
    );
  });
});

describe("<ChartLegendContent>", () => {
  test("renders one swatch + label per series from the config", () => {
    const config = chartConfig([
      { key: "landed", label: "Landed" },
      { key: "inflight", label: "In flight" },
    ]);
    const html = renderToStaticMarkup(
      <ChartProvider config={config}>
        <ChartLegendContent
          payload={[
            { dataKey: "landed", value: "landed", color: "#2a78d6" },
            { dataKey: "inflight", value: "inflight", color: "#eb6834" },
          ]}
        />
      </ChartProvider>,
    );
    expect(html).toContain('data-slot="chart-legend"');
    expect(html).toContain("Landed");
    expect(html).toContain("In flight");
    expect(html).toContain("background:#2a78d6");
    expect(html).toContain("background:#eb6834");
  });
});
