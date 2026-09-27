/*
 * The graph, hardened: what it does when it has nothing, when it is refused,
 * and what it says to a reader who is not looking at it.
 *
 * Three rules are pinned here, and each of them is a rule the rest of the
 * lane can only state once:
 *
 *  - A failure is visible and answerable. Every way a plan can fail leaves
 *    the card saying so, with the door that asks again beside it, and never
 *    a success state.
 *  - Nothing is a picture of nothing. A plan with no nodes draws no canvas
 *    and says no sentence about it (MINIMAL TEXT).
 *  - The state is a word and a role, never a colour. Every node is a
 *    focusable button carrying its tag, its id and its state word, so a
 *    screenshot and a screen reader read the same graph.
 *
 * The recorded run (`fixtures/GraphRunJournal.json`) is the evidence for
 * everything a run says; nothing below invents an event, an outcome or a
 * field the engine does not write.
 */
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import type { GraphDrill } from "./FlowGraphDrawer"
import { flowGraphModel, layoutFlowGraph, type PlanCardNode } from "./FlowGraph"
import { FlowGraphSurface } from "./FlowGraphSurface"
import { FlowRunGraphSurface } from "./FlowRunGraphSurface"
import { FlowPlanCardBody } from "./FlowPlanCard"
import { foldRunGraph, runGraphOf } from "./FlowGraphStatus"
import { planCardState } from "./flowGraph/PlanState"
import type { JournalRecord } from "./RunTrace"
import { PALETTES, type Card } from "../state/AppState"
import { ratioOf, rootTokens, variant } from "../styles/paletteTokens"

GlobalRegistrator.register()
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const mounted: Array<{ root: Root; host: HTMLElement }> = []
afterEach(async () => {
  for (const { root, host } of mounted.splice(0)) {
    await act(async () => root.unmount())
    host.remove()
  }
})
afterAll(async () => {
  for (let tick = 0; tick < 3; tick += 1) await new Promise((resolve) => setTimeout(resolve, 0))
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT
  await GlobalRegistrator.unregister()
})

const render = (element: React.ReactElement): HTMLElement => {
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  mounted.push({ root, host })
  act(() => root.render(element))
  return host
}

interface Recorded {
  readonly flow: string
  readonly plan: { readonly nodes: ReadonlyArray<{ readonly id: string }> }
  readonly rows: Array<JournalRecord>
}
const RECORDED: Recorded = JSON.parse(readFileSync(new URL("./fixtures/GraphRunJournal.json", import.meta.url), "utf8"))

/** The execution that drove the recorded plan, folded as a run card folds it. */
const recordedGraph = (rows: ReadonlyArray<JournalRecord> = RECORDED.rows) => {
  const found = runGraphOf(foldRunGraph(rows), { planNodeIds: RECORDED.plan.nodes.map((node) => node.id) })
  if (found === undefined) throw new Error("the recording carries no execution covering the plan")
  return found
}

const STEADY = "root.flow.then.map.all.steady"

const node = (id: string, dependsOn: Array<string> = [], over: Partial<PlanCardNode> = {}): PlanCardNode => ({
  id,
  kind: "step",
  key: `key1_${"0".repeat(64)}`,
  dependsOn,
  tier: "sealed",
  status: "run",
  ...over
})

const NODES = [node("a", [], { action: "files/read" }), node("b", ["a"], { kind: "agent", action: "agent/run" })]

type FlowPlanCard = Extract<Card, { kind: "flow-plan" }>

const card = (payload: Partial<FlowPlanCard["payload"]>): FlowPlanCard => ({
  id: "flow-plan-1",
  kind: "flow-plan",
  title: "review",
  status: "active",
  createdAt: 0,
  ordinal: 0,
  payload: { repo: "o/r", flowId: "review", status: "pending", ...payload }
})

const drill = (over: Partial<GraphDrill> = {}): GraphDrill => ({
  repo: "o/r",
  doors: { select: "flow.plan.select", tab: "flow.plan.tab", target: "flow-plan-1" },
  onRunCommand: () => {},
  ...over
})

/** Every drawn node's wrapper, which is the element a reader tabs to. */
const buttons = (host: HTMLElement): ReadonlyArray<HTMLElement> =>
  [...host.querySelectorAll<HTMLElement>(".react-flow__node")]

/*
 * Every way a plan card can end up, and what the card owes a reader in each.
 *
 * The vocabulary is the card's own (`Cards.ts`: `pending | done | failed`),
 * because it is the only failure vocabulary the plan seam writes. The relay
 * states a refusal in a sentence and the seam keeps that sentence, so a
 * provisioning, no-capacity or quota refusal arrives here as `failed` with
 * the relay's own words — which is why every one of them is asserted through
 * the same door rather than through a code the card was never given.
 */
describe("a plan card states every ending it has", () => {
  test("the fold is exhaustive and no ending is a success state", () => {
    expect(planCardState(card({ status: "pending" }).payload)).toEqual({ kind: "planning" })
    expect(planCardState(card({ status: "done", nodes: NODES }).payload)).toEqual({ kind: "planned", nodes: NODES })
    /* A plan that answered with no nodes is not a plan that drew a graph. */
    expect(planCardState(card({ status: "done", nodes: [] }).payload)).toEqual({ kind: "planned", nodes: [] })
    expect(planCardState(card({ status: "failed", error: "nope" }).payload))
      .toEqual({ kind: "refused", sentence: "nope" })
    /* A refusal with no sentence is still a refusal, never a plan. */
    expect(planCardState(card({ status: "failed" }).payload)).toEqual({ kind: "refused" })
  })

  /*
   * The four sentences the seam can hand a plan card: three workspace
   * states, each with a message, and the control plane's own refusal. The card is handed the sentence, so what is pinned
   * is that each one lands on the card with the door that asks again.
   */
  test.each([
    ["The workspace for o/r is still being prepared — try again in a moment."],
    ["No workspace capacity right now."],
    ["You already have 5 boxes running."],
    ["There's no flow called review on o/r."]
  ])("a refusal stays on the card with the door that asks again: %s", (sentence) => {
    const host = render(
      <FlowPlanCardBody card={card({ status: "failed", error: sentence })} onRunCommand={() => {}} />
    )
    expect(host.querySelector(".flow-plan-error")?.textContent).toBe(sentence)
    expect(host.querySelector("[data-flow=\"flow.plan\"]")).not.toBeNull()
    /* Run is the success door. A refused plan never offers it. */
    expect(host.querySelector("[data-flow=\"flow.run\"]")).toBeNull()
  })

  /*
   * A plan refused after it had already drawn a graph keeps the graph — the
   * seam writes the refusal over the status and keeps the nodes — and the
   * card still has to read as refused, not as the plan it was.
   */
  test("a refusal over a drawn graph is still a refusal", () => {
    const host = render(
      <FlowPlanCardBody
        card={card({ status: "failed", error: "No workspace capacity right now.", nodes: NODES })}
        onRunCommand={() => {}}
      />
    )
    expect(host.querySelector(".flow-plan-error")?.textContent).toBe("No workspace capacity right now.")
    expect(host.querySelector("[data-flow=\"flow.run\"]")).toBeNull()
    expect(host.querySelector("[data-flow=\"flow.plan\"]")).not.toBeNull()
  })
})

describe("nothing is drawn as nothing", () => {
  test("a plan with no nodes draws no canvas, no count and no sentence about it", () => {
    const host = render(<FlowPlanCardBody card={card({ status: "done", nodes: [] })} onRunCommand={() => {}} />)
    expect(host.querySelector(".flow-plan-canvas")).toBeNull()
    expect(host.querySelector(".flow-plan-count")).toBeNull()
    expect(host.querySelectorAll("p").length).toBe(0)
    /* The head is the door and nothing else: no count, no sentence (MINIMAL TEXT). */
    expect(host.querySelector(".flow-plan-head")?.textContent).toBe("Run")
  })

  test("a surface handed no nodes draws nothing at all", () => {
    expect(render(<FlowGraphSurface nodes={[]} drill={drill()} />).textContent).toBe("")
    expect(render(<FlowRunGraphSurface nodes={[]} edges={[]} status={new Map()} drill={drill()} />).textContent).toBe("")
  })

  /*
   * A plan the control journal's window evicted keeps its nodes and loses its
   * edges. The nodes are still what the flow would run, so they are still
   * drawn; a graph that refused to draw because it lost its edges would hide
   * evidence the card holds.
   */
  test("a plan with nodes and no edges draws its nodes", () => {
    const host = render(<FlowGraphSurface nodes={NODES} graph={{ edges: [] }} drill={drill()} />)
    expect(buttons(host).map((drawn) => drawn.getAttribute("data-id"))).toEqual(["a", "b"])
    expect(host.querySelectorAll(".react-flow__edge").length).toBe(0)
  })

  /*
   * The history this flow has measured is read through the projection, and a
   * box that does not know the selector dies on it without a code
   * (`GatewayServer.test.ts`). The reader swallows that, so the graph is
   * handed no rows — and a node with no measured history wears no prediction
   * rather than an empty one (D-030, MINIMAL TEXT).
   */
  test("a graph with no measured history wears no prediction", () => {
    const host = render(<FlowGraphSurface nodes={NODES} durations={[]} drill={drill()} />)
    expect(host.querySelector(".flow-graph-node-eta")).toBeNull()
    expect(host.querySelector(".flow-plan-eta")).toBeNull()
  })
})

describe("a hole in the history is a hole, never an idle node", () => {
  /*
   * The projection admits a gap on the execution the recorded run drove.
   * Every node that had not already settled becomes `unproven`: `pending`
   * there would be the card claiming the node never started, which the
   * evidence no longer supports.
   */
  test("a gapped run reads unproven, and never pending", () => {
    /* The recording, cut before its first settlement: the nodes that follow
     * are exactly the ones the hole could have swallowed. */
    const firstSettled = RECORDED.rows.findIndex((row) =>
      (row.payload as { eventType?: unknown }).eventType === "flows.engine.node-settled")
    expect(firstSettled).toBeGreaterThan(0)
    const opening = RECORDED.rows.slice(0, firstSettled)
    const gap: JournalRecord = {
      ...RECORDED.rows[0]!,
      sequence: 10_000,
      kind: "control.engine.projection-gap",
      payload: { executionId: recordedGraph(opening).executionId, generation: null }
    }
    const found = recordedGraph([...opening, gap])
    const host = render(
      <FlowRunGraphSurface nodes={found.nodes} edges={found.edges} status={found.status} drill={drill()} />
    )
    const words = [...host.querySelectorAll(".flow-graph-node-word")].map((word) => word.textContent)
    expect(words).not.toContain("pending")
    expect(new Set(words).has("unproven")).toBe(true)
  })
})

describe("every node is a button a reader can reach", () => {
  test("a plan node is a focusable button labelled by its tag, its id and its state word", () => {
    const host = render(<FlowGraphSurface nodes={NODES} drill={drill({ selected: "a" })} />)
    const drawn = buttons(host)
    expect(drawn.map((element) => element.getAttribute("role"))).toEqual(["button", "button"])
    expect(drawn.map((element) => element.getAttribute("tabindex"))).toEqual(["0", "0"])
    expect(drawn.map((element) => element.getAttribute("aria-label")))
      .toEqual(["files/read a run", "agent/run b run"])
    /* Which node is open is in the accessibility tree, not only in the ring. */
    expect(drawn.map((element) => element.getAttribute("aria-expanded"))).toEqual(["true", "false"])
  })

  test("a run node is labelled with the word the engine settled it at", () => {
    const found = recordedGraph()
    const host = render(
      <FlowRunGraphSurface nodes={found.nodes} edges={found.edges} status={found.status} drill={drill()} />
    )
    const labelled = buttons(host).find((element) => element.getAttribute("data-id") === STEADY)
    expect(labelled?.getAttribute("aria-label")).toBe(`gateway/graph/Steady ${STEADY} built`)
    expect(labelled?.getAttribute("role")).toBe("button")
  })

  /*
   * The state is readable with the colours off: every node carries its word
   * as text, and the word is the engine's own.
   */
  test("every drawn node carries its state as a word", () => {
    const found = recordedGraph()
    const host = render(
      <FlowRunGraphSurface nodes={found.nodes} edges={found.edges} status={found.status} drill={drill()} />
    )
    for (const drawn of buttons(host)) {
      const word = drawn.querySelector(".flow-graph-node-word")?.textContent ?? ""
      expect(word).not.toBe("")
      expect(drawn.getAttribute("aria-label")?.endsWith(word)).toBe(true)
    }
  })

  /*
   * Enter, pressed on the node the browser focus is really on.
   *
   * The focus target is React Flow's wrapper, not the card inside it, so a
   * key arrives on an element where `closest("[data-node]")` finds nothing.
   * The DOM this asserts on is the DOM a keyboard produces.
   */
  test("Enter on the focused wrapper opens that node", () => {
    const ran: Array<[string, string | undefined]> = []
    const host = render(
      <FlowGraphSurface nodes={NODES} drill={drill({ onRunCommand: (name, args) => ran.push([name, args]) })} />
    )
    const wrapper = buttons(host).find((node) => node.getAttribute("data-id") === "b")!
    wrapper.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
    expect(ran).toEqual([["flow.plan.select", "flow-plan-1 b"]])
  })

  /* D-038 / D-050: with the flag off there is no selection model to expose. */
  test("without the drill-in a node is not a button and claims no open state", () => {
    const host = render(<FlowGraphSurface nodes={NODES} />)
    const drawn = buttons(host)
    expect(drawn.map((element) => element.getAttribute("role"))).toEqual(["group", "group"])
    expect(drawn.map((element) => element.getAttribute("aria-expanded"))).toEqual([null, null])
  })
})

/*
 * The stylesheet, in every theme the product ships.
 *
 * `styles/tokens.css` IS the source of every colour painted, so the ratios
 * below are computed from its declarations: a ratio taken from the palette
 * table cannot pass while the pixels fail, and it covers all eighteen cells
 * on every `bun test` rather than only on a machine with Chromium
 * (styles/paletteTokens.ts, the same resolver styles/Contrast.test.ts uses).
 */
describe("the graph is dressed from the tokens, in both themes and all nine palettes", () => {
  const sheet = readFileSync(new URL("../styles/flow-graph.css", import.meta.url), "utf8")
  /** Comments carry hex-looking prose and brace pairs, so the scans read the code alone. */
  const css = sheet.replace(/\/\*[\s\S]*?\*\//g, "")

  /** Every custom property the sheet reads. */
  const used = [...new Set([...css.matchAll(/var\((--[a-z0-9-]+)/g)].map((match) => match[1]!))]

  /** Every custom property the sheet sets itself, which are its own and not the palette's. */
  const owned = new Set([...css.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm)].map((match) => match[1]!))

  test("carries no colour of its own: zero hex literals", () => {
    expect([...css.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((match) => match[0])).toEqual([])
    expect([...css.matchAll(/\b(?:rgba?|hsla?)\(/g)].map((match) => match[0])).toEqual([])
  })

  test("every token it reads is one the palette table declares", () => {
    const declared = rootTokens()
    /* `--flow-run-fill` is the node's own, written by the component that draws the bar. */
    expect(used.filter((token) => !declared.has(token) && !owned.has(token) && token !== "--flow-run-fill")).toEqual([])
  })

  /*
   * The floor for text, in every cell. A node's box is `--surface`, so that
   * is what every word in it is read on.
   *
   * The state words come off the NEUTRAL ramp on purpose. The semantic hues
   * are short of AA in some palettes where the product paints them small
   * (`--danger` is 2.81:1 in solarized dark, `--brand` 3.05:1 in solarized
   * light), and the word is the carrier of the state (D-026), so the carrier
   * has to be legible in all eighteen. A hue only ever repeats what a word
   * already says.
   */
  test("every colour it paints a word with clears 4.5:1 on a node, in all eighteen cells", () => {
    const painted = [
      ...new Set([...css.matchAll(/(?:^|[;{\s])color:\s*var\((--[a-z0-9-]+)\)/gm)].map((match) => match[1]!))
    ]
    expect(painted.length).toBeGreaterThan(0)
    const failures: Array<string> = []
    for (const palette of PALETTES) {
      for (const mode of ["light", "dark"] as const) {
        const declarations = variant(palette, mode)
        for (const token of painted) {
          const ratio = ratioOf(declarations, token, "--surface")
          if (ratio < 4.5) failures.push(`${palette} ${mode}: ${token} on --surface is ${ratio}:1`)
        }
      }
    }
    expect(failures).toEqual([])
  })

  /*
   * Nothing on the canvas is faded.
   *
   * `opacity` composites the WHOLE box over the canvas behind it, the word
   * inside included, so a rule that dims a settled node dims its word with
   * it: `--text-muted` at 0.72 over `--surface-2` reads 3.07:1 in solarized
   * light, and `--text-faint` 2.89:1 in gruvbox light, both under the floor
   * the test above holds. That test cannot see it, because it resolves the
   * `color:` token and a computed colour knows nothing of an ancestor's
   * opacity. A state is a word before it is a colour (D-026) and `pending`
   * is the commonest word a run graph shows, so nothing here fades one.
   *
   * 0 and 1 are not a fade: the two handles are hidden outright.
   */
  test("nothing is faded: the sheet declares no opacity but 0 and 1", () => {
    const faded = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].flatMap((block) => {
      const value = /(?:^|[;\s])opacity:\s*([\d.]+)/.exec(block[2] ?? "")?.[1]
      return value === undefined || Number(value) === 0 || Number(value) === 1
        ? []
        : [`${(block[1] ?? "").trim().replace(/\s+/g, " ")} { opacity: ${value} }`]
    })
    expect(faded).toEqual([])
  })

  /*
   * The floor for the edges. An edge is what makes the picture a graph rather
   * than a list, so it is a graphical object a reader needs (WCAG 1.4.11) and
   * its floor is 3:1 — against the canvas, which is `--surface-2`.
   */
  test("the edges clear 3:1 against the canvas, in all eighteen cells", () => {
    const stroke = /\.flow-graph-edge[^{]*\{[^}]*stroke:\s*var\((--[a-z0-9-]+)\)/.exec(css)?.[1]
    expect(stroke).toBeDefined()
    const failures: Array<string> = []
    for (const palette of PALETTES) {
      for (const mode of ["light", "dark"] as const) {
        const ratio = ratioOf(variant(palette, mode), stroke!, "--surface-2")
        if (ratio < 3) failures.push(`${palette} ${mode}: ${stroke} on --surface-2 is ${ratio}:1`)
      }
    }
    expect(failures).toEqual([])
  })

  /*
   * Motion is opt-in. Every animation the sheet declares lives inside a
   * `prefers-reduced-motion: no-preference` block, so a reader who asked for
   * less motion is never handed any — and the state word, which is what the
   * motion decorates, does not move at all.
   */
  test("every animation it declares is inside a no-preference block", () => {
    const blocks = [...css.matchAll(/@media \(prefers-reduced-motion: no-preference\)\s*\{/g)]
      .map((match) => {
        const start = match.index! + match[0].length
        let depth = 1
        let index = start
        while (depth > 0 && index < css.length) {
          if (css[index] === "{") depth += 1
          if (css[index] === "}") depth -= 1
          index += 1
        }
        return { start, end: index }
      })
    const inside = (at: number): boolean => blocks.some((block) => at >= block.start && at < block.end)
    const motion = [...css.matchAll(/(?:^|[^-])animation(?:-name)?:|@keyframes /gm)]
    expect(motion.length).toBeGreaterThan(0)
    expect(motion.filter((match) => !inside(match.index!)).map((match) => match[0])).toEqual([])
  })

  /*
   * The focus ring is the one thing a keyboard reader has, and a node is a
   * button now, so it has to have one.
   */
  test("a focused node and a focused tab both take a visible ring", () => {
    expect(/:focus-visible[^{]*\.flow-graph-node\s*\{/.test(css)).toBe(true)
    expect(/\.flow-graph-drawer-tab:focus-visible/.test(css)).toBe(true)
  })

  /*
   * There is no camera tween to disable: React Flow's `fitView` moves the
   * viewport in one frame unless it is handed a `duration`, and neither
   * canvas hands it one. Pinned so that a tween cannot arrive without a
   * reduced-motion answer beside it.
   */
  test("neither canvas asks React Flow to animate the camera", () => {
    for (const name of ["FlowGraphSurface.tsx", "FlowRunGraphSurface.tsx"]) {
      const source = readFileSync(new URL(`./${name}`, import.meta.url), "utf8")
      expect([...source.matchAll(/fitViewOptions=\{[^}]*duration/g)].map((match) => match[0])).toEqual([])
    }
  })
})

/*
 * The drawer, to a keyboard.
 *
 * The tab strip follows the ARIA tabs pattern: one tab stop into the strip,
 * then the arrows move along it. Every move is the same flow a click runs
 * (THE THREE-DOOR LAW), so the keyboard reaches nothing the pointer and the
 * agent cannot.
 */
describe("the drawer is reachable with a keyboard", () => {
  const openDrawer = (tab?: "declaration" | "code" | "events" | "attempts") => {
    const found = recordedGraph()
    const node = found.nodes.find((candidate) => candidate.id === STEADY)!
    return render(
      <FlowRunGraphSurface
        nodes={found.nodes}
        edges={found.edges}
        status={found.status}
        records={RECORDED.rows}
        drill={drill({
          doors: { select: "runs.graph.select", tab: "runs.graph.tab", target: "run-1" },
          selected: node.id,
          ...(tab === undefined ? {} : { tab })
        })}
      />
    )
  }

  test("the strip is one tab stop, and the tab that is showing is the stop", () => {
    const host = openDrawer("events")
    const strip = [...host.querySelectorAll<HTMLElement>("[role='tab']")]
    expect(strip.length).toBeGreaterThan(1)
    expect(strip.filter((tab) => tab.getAttribute("tabindex") === "0").map((tab) => tab.getAttribute("data-tab")))
      .toEqual(["events"])
    expect(strip.filter((tab) => tab.getAttribute("tabindex") === "-1").length).toBe(strip.length - 1)
  })

  test("a tab names the panel it controls, and the panel names the tab", () => {
    const host = openDrawer("events")
    const shown = host.querySelector("[role='tab'][aria-selected='true']")!
    const panel = host.querySelector("[role='tabpanel']")!
    expect(shown.getAttribute("aria-controls")).toBe(panel.getAttribute("id"))
    expect(panel.getAttribute("aria-labelledby")).toBe(shown.getAttribute("id"))
    expect(shown.getAttribute("id")).not.toBeNull()
  })

  test("the drawer is a labelled group, not a landmark in a transcript of them", () => {
    const host = openDrawer()
    const drawer = host.querySelector(".flow-graph-drawer")!
    expect(drawer.getAttribute("role")).toBe("group")
    expect(drawer.getAttribute("aria-label")).toBe("gateway/graph/Steady")
  })

  test("the arrows walk the strip through the same flow a click runs", () => {
    const ran: Array<[string, string | undefined]> = []
    const found = recordedGraph()
    const host = render(
      <FlowRunGraphSurface
        nodes={found.nodes}
        edges={found.edges}
        status={found.status}
        records={RECORDED.rows}
        drill={drill({
          doors: { select: "runs.graph.select", tab: "runs.graph.tab", target: "run-1" },
          selected: STEADY,
          tab: "declaration",
          onRunCommand: (name, args) => ran.push([name, args])
        })}
      />
    )
    const strip = host.querySelector("[role='tablist']")!
    strip.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }))
    /* This node settled with a value, so Output is the tab after Declaration (D-052). */
    expect(ran).toEqual([["runs.graph.tab", "run-1 output"]])
    strip.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }))
    expect(ran.at(-1)).toEqual(["runs.graph.tab", "run-1 attempts"])
    /* The end of the strip is the end: the arrow past it runs nothing. */
    ran.length = 0
    strip.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }))
    expect(ran).toEqual([])
  })
})

/*
 * The two heaviest things this app can load stay behind the one boundary
 * that keeps them out of the main chunk.
 *
 * `ViewModules.ts` reaches both canvases through `import()`, which is where
 * the bundler splits, so the assertion is about the module graph in front of
 * that call: as long as nothing on the main side imports a VALUE from the
 * three modules that name `@xyflow/react` or `dagre`, no chunk a first paint
 * loads can contain either. A type import is erased and costs nothing.
 *
 * e2e/graph/flow-graph-a11y.spec.ts asserts the same thing from the other
 * end, in a real browser: xyflow's stylesheet is absent until a graph opens.
 */
describe("xyflow and dagre stay behind the lazy boundary", () => {
  const productionSources = async (): Promise<ReadonlyArray<{ readonly path: string; readonly source: string }>> => {
    const root = fileURLToPath(new URL("../..", import.meta.url))
    const found: Array<{ path: string; source: string }> = []
    for (const pattern of ["**/*.ts", "**/*.tsx"]) {
      for await (const path of new Bun.Glob(pattern).scan({ cwd: root, absolute: true })) {
        if (path.includes(".test.")) continue
        found.push({ path: path.slice(root.length), source: readFileSync(path, "utf8") })
      }
    }
    return found
  }

  /**
   * Every module one source names in a static `import ... from`, a bare
   * `import "<module>"`, or an `export ... from`: a re-export pulls the
   * module into the chunk exactly as an import does.
   *
   * A statement starts at column zero and the gap before its `from` may span
   * lines, because an import list does, but it may not run into the NEXT
   * statement: that is what the lookahead forbids, so an `export` with a
   * body above an import cannot swallow the import under it.
   */
  const modulesOf = (source: string): ReadonlyArray<{ readonly statement: string; readonly module: string }> =>
    [...source.matchAll(
      /^(?:import|export)\s+(?:(?!\n(?:import|export)\b)[^;])*?\bfrom\s+["']([^"']+)["']|^import\s+["']([^"']+)["']/gm
    )].map((match) => ({ statement: match[0], module: match[1] ?? match[2] ?? "" }))

  /** A type-only statement is erased by the compiler, so it costs no chunk. */
  const ERASED = /^(?:import|export)\s+type\s/

  const HEAVY = /^(?:@xyflow\/react|dagre)(?:\/|$)/

  /*
   * A re-export is an import. `export { layoutFlowGraph } from "./FlowGraph"`
   * in a barrel on the main side pulls dagre into the main chunk exactly as
   * an import would, and the two tests below are the only thing standing
   * between that statement and a first paint that loads it.
   */
  test("the scan reads a re-export as well as an import", () => {
    expect(modulesOf("export { layoutFlowGraph } from \"./FlowGraph\"").map(({ module }) => module))
      .toEqual(["./FlowGraph"])
    expect(modulesOf("export * from \"./FlowGraphSurface\"").map(({ module }) => module))
      .toEqual(["./FlowGraphSurface"])
    /* A type-only re-export is erased, exactly as a type-only import is. */
    expect(modulesOf("export type { PlanCardNode } from \"./FlowGraph\"").map(({ statement }) => ERASED.test(statement)))
      .toEqual([true])
    /* A bodied export above an import does not swallow the import under it. */
    expect(modulesOf("export const ready = true\nimport { FlowGraph } from \"./FlowGraph\"").map(({ module }) => module))
      .toEqual(["./FlowGraph"])
  })

  test("only the two canvases and the layout module name them at all", async () => {
    const naming = (await productionSources())
      .filter(({ source }) => modulesOf(source).some(({ module }) => HEAVY.test(module)))
      .map(({ path }) => path)
      .sort()
    expect(naming).toEqual([
      "mainview/cards/FlowGraph.ts",
      "mainview/cards/FlowGraphSurface.tsx",
      "mainview/cards/FlowRunGraphSurface.tsx"
    ])
  })

  test("nothing on the main side imports a value from them", async () => {
    const behind = new Set([
      "mainview/cards/FlowGraph.ts",
      "mainview/cards/FlowGraphSurface.tsx",
      "mainview/cards/FlowRunGraphSurface.tsx"
    ])
    const offenders: Array<string> = []
    for (const { path, source } of await productionSources()) {
      if (behind.has(path)) continue
      for (const { statement, module } of modulesOf(source)) {
        const target = /\/?FlowGraph$|\/?FlowGraphSurface$|\/?FlowRunGraphSurface$/.test(module)
        if (!target || ERASED.test(statement)) continue
        offenders.push(`${path} imports a value from ${module}`)
      }
    }
    expect(offenders).toEqual([])
  })

  test("the only way in is the dynamic import", async () => {
    const views = readFileSync(new URL("../ViewModules.ts", import.meta.url), "utf8")
    for (const name of ["FlowGraphSurface", "FlowRunGraphSurface"]) {
      expect(views).toContain(`import("./cards/${name}")`)
    }
    expect(modulesOf(views).filter(({ module }) => module.includes("FlowGraph"))).toEqual([])
  })
})

/*
 * A big plan is still a plan a card can draw.
 *
 * Layout is the one thing on this path that is not linear in the node count,
 * and it runs on the main thread before the first frame of a graph.
 *
 * The finite positions and dependency order are independent of host load.
 */
describe("large graph layout", () => {
  /* A wide fan-out under one root, which is the shape dagre works hardest
   * on: a hundred nodes on the second rank and the rest under them. */
  const fanOut = (count: number): ReturnType<typeof flowGraphModel> => {
    const wide: Array<PlanCardNode> = [node("root")]
    for (let index = 0; index < count - 1; index += 1) {
      wide.push(node(`n${index}`, [index < 100 ? "root" : `n${index % 100}`], { action: "files/read" }))
    }
    return flowGraphModel(wide)
  }

  // Repeated-render work is pinned by the dagre spy in FlowRunGraph.test.tsx.
  // A timing ratio over twenty layouts measured host contention instead.
  test("lays out a 500-node fan-out with every dependency", () => {
    const laid = layoutFlowGraph(fanOut(500))
    expect(laid.nodes).toHaveLength(500)
    expect(laid.edges).toHaveLength(499)
    const positions = new Map(laid.nodes.map(node => [node.id, node.position]))
    for (const node of laid.nodes) expect(Number.isFinite(node.position.x) && Number.isFinite(node.position.y)).toBe(true)
    for (const edge of laid.edges) expect(positions.get(edge.source)!.y).toBeLessThan(positions.get(edge.target)!.y)
  })
})
