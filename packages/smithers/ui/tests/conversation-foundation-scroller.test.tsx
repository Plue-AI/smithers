/** @jsxImportSource react */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  MessageScrollerButton,
  type MessageScrollerCommands,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
  useMessageScroller,
  useMessageScrollerState,
  useMessageVisibility,
} from "../src/chat/MessageScroller";
import { SMITHERS_UI_STYLE_ATTR } from "../src/index";
import { installDarkThemeStyles, removeDarkThemeStyles } from "./theme-test-utils";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean; }).IS_REACT_ACT_ENVIRONMENT = true;

type Metrics = { scrollHeight: number; clientHeight: number; scrollTop: number; };

const metricsByElement = new WeakMap<HTMLElement, Metrics>();
const geometryByMessageId = new Map<string, { top: number; height: number; }>();
let defaultMetrics: Metrics = { scrollHeight: 0, clientHeight: 0, scrollTop: 0 };
// Simulates the transcript sitting below page chrome: rect coordinates carry
// this offset while scroll-content coordinates never do.
let pageOffset = 0;
const originalDescriptors = new Map<string, PropertyDescriptor | undefined>();
const resizeCallbacks = new Map<Element, ResizeObserverCallback>();
const originalResizeObserver = globalThis.ResizeObserver;

class ManualResizeObserver implements ResizeObserver {
  readonly callback: ResizeObserverCallback;
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
  }
  observe(target: Element): void {
    resizeCallbacks.set(target, this.callback);
  }
  unobserve(target: Element): void {
    resizeCallbacks.delete(target);
  }
  disconnect(): void {
    for (const [target, callback] of resizeCallbacks) {
      if (callback === this.callback) resizeCallbacks.delete(target);
    }
  }
}

beforeAll(() => {
  for (
    const property of [
      "scrollHeight",
      "clientHeight",
      "scrollTop",
      "offsetTop",
      "offsetHeight",
      "getBoundingClientRect",
    ]
  ) {
    originalDescriptors.set(property, Object.getOwnPropertyDescriptor(HTMLElement.prototype, property));
  }
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get() {
      if ((this as HTMLElement).dataset.slot !== "message-scroller-viewport") return 0;
      return metricsByElement.get(this as HTMLElement)?.scrollHeight ?? defaultMetrics.scrollHeight;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get() {
      if ((this as HTMLElement).dataset.slot !== "message-scroller-viewport") return 0;
      return metricsByElement.get(this as HTMLElement)?.clientHeight ?? defaultMetrics.clientHeight;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "scrollTop", {
    configurable: true,
    get() {
      if ((this as HTMLElement).dataset.slot !== "message-scroller-viewport") return 0;
      return metricsByElement.get(this as HTMLElement)?.scrollTop ?? defaultMetrics.scrollTop;
    },
    set(value: number) {
      if ((this as HTMLElement).dataset.slot !== "message-scroller-viewport") return;
      const current = metricsByElement.get(this as HTMLElement) ?? { ...defaultMetrics };
      current.scrollTop = value;
      metricsByElement.set(this as HTMLElement, current);
    },
  });
  Object.defineProperty(HTMLElement.prototype, "offsetTop", {
    configurable: true,
    get() {
      const id = (this as HTMLElement).dataset.messageId;
      return (id && geometryByMessageId.get(id)?.top) || 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get() {
      const id = (this as HTMLElement).dataset.messageId;
      return (id && geometryByMessageId.get(id)?.height) || 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
    configurable: true,
    value(this: HTMLElement): DOMRect {
      const base = { left: 0, right: 0, width: 0, x: 0, toJSON: () => ({}) };
      if (this.dataset.slot === "message-scroller-viewport") {
        const height = this.clientHeight;
        return { ...base, top: pageOffset, bottom: pageOffset + height, height, y: pageOffset } as DOMRect;
      }
      const id = this.dataset.messageId;
      const geom = id ? geometryByMessageId.get(id) : undefined;
      if (geom) {
        const viewport = document.querySelector<HTMLElement>('[data-slot="message-scroller-viewport"]');
        const scrollTop = viewport?.scrollTop ?? 0;
        const top = pageOffset + geom.top - scrollTop;
        return { ...base, top, bottom: top + geom.height, height: geom.height, y: top } as DOMRect;
      }
      return { ...base, top: 0, bottom: 0, height: 0, y: 0 } as DOMRect;
    },
  });
  globalThis.ResizeObserver = ManualResizeObserver;
});

afterAll(() => {
  for (const [property, descriptor] of originalDescriptors) {
    if (descriptor) Object.defineProperty(HTMLElement.prototype, property, descriptor);
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[property];
  }
  globalThis.ResizeObserver = originalResizeObserver;
});

let container: HTMLElement | undefined;
let root: Root | undefined;

afterEach(async () => {
  if (root) {
    const mountedRoot = root;
    await act(async () => mountedRoot.unmount());
    root = undefined;
  }
  container?.remove();
  container = undefined;
  defaultMetrics = { scrollHeight: 0, clientHeight: 0, scrollTop: 0 };
  pageOffset = 0;
  geometryByMessageId.clear();
  resizeCallbacks.clear();
  document.documentElement.removeAttribute("data-theme");
  removeDarkThemeStyles();
  document.querySelectorAll(`style[${SMITHERS_UI_STYLE_ATTR}]`).forEach((element) => element.remove());
});

async function render(element: ReactElement, metrics: Metrics): Promise<void> {
  defaultMetrics = { ...metrics };
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const mountedRoot = root;
  await act(async () => mountedRoot.render(element));
  metricsByElement.set(getViewport(), { ...metrics, scrollTop: getViewport().scrollTop });
}

async function renderWithLateViewport(
  view: (viewportMounted: boolean) => ReactElement,
  metrics: Metrics,
): Promise<void> {
  defaultMetrics = { ...metrics };
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const mountedRoot = root;
  await act(async () => mountedRoot.render(view(false)));
  await act(async () => {
    await Promise.resolve();
    mountedRoot.render(view(true));
  });
  metricsByElement.set(getViewport(), { ...metrics, scrollTop: getViewport().scrollTop });
}

function getViewport(): HTMLDivElement {
  return container!.querySelector<HTMLDivElement>('[data-slot="message-scroller-viewport"]')!;
}

function getItem(messageId: string): HTMLElement {
  return container!.querySelector<HTMLElement>(`[data-message-id="${messageId}"]`)!;
}

function metrics(): Metrics {
  return metricsByElement.get(getViewport())!;
}

async function scroll(): Promise<void> {
  await act(async () => getViewport().dispatchEvent(new Event("scroll", { bubbles: true })));
}

describe("MessageScroller compound", () => {
  test("viewport is a labeled keyboard region; content defaults to role=log", async () => {
    await render(
      <MessageScrollerProvider>
        <MessageScrollerViewport>
          <MessageScrollerContent>
            <MessageScrollerItem messageId="m1">hello</MessageScrollerItem>
          </MessageScrollerContent>
        </MessageScrollerViewport>
      </MessageScrollerProvider>,
      { scrollHeight: 1000, clientHeight: 200, scrollTop: 0 },
    );
    const viewport = getViewport();
    expect(viewport.getAttribute("role")).toBe("region");
    expect(viewport.getAttribute("aria-label")).toBe("Conversation messages");
    expect(viewport.tabIndex).toBe(0);
    const content = container!.querySelector<HTMLElement>('[data-slot="message-scroller-content"]')!;
    expect(content.getAttribute("role")).toBe("log");
    const item = getItem("m1");
    expect(item.className).toContain("sui-msg-scroller-item");
    expect(item.style.getPropertyValue("--sui-msg-intrinsic")).toBe("96px");
  });

  test("content role is overridable and items accept a custom intrinsic size", async () => {
    await render(
      <MessageScrollerProvider>
        <MessageScrollerViewport>
          <MessageScrollerContent role="list">
            <MessageScrollerItem messageId="m1" intrinsicSize={140}>
              hello
            </MessageScrollerItem>
          </MessageScrollerContent>
        </MessageScrollerViewport>
      </MessageScrollerProvider>,
      { scrollHeight: 1000, clientHeight: 200, scrollTop: 0 },
    );
    expect(container!.querySelector('[data-slot="message-scroller-content"]')!.getAttribute("role")).toBe("list");
    expect(getItem("m1").style.getPropertyValue("--sui-msg-intrinsic")).toBe("140px");
  });

  test("scrollAnchor=bottom pins on mount and follows content growth", async () => {
    const states: { atTop: boolean; atBottom: boolean; following: boolean; }[] = [];
    function Probe() {
      states.push(useMessageScrollerState());
      return null;
    }
    await render(
      <MessageScrollerProvider scrollAnchor="bottom">
        <MessageScrollerViewport>
          <MessageScrollerContent>
            <MessageScrollerItem messageId="m1">hello</MessageScrollerItem>
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <Probe />
      </MessageScrollerProvider>,
      { scrollHeight: 1000, clientHeight: 200, scrollTop: 0 },
    );
    expect(getViewport().scrollTop).toBe(1000);
    expect(states.at(-1)!.following).toBe(true);

    metrics().scrollHeight = 1200;
    const content = container!.querySelector('[data-slot="message-scroller-content"]')!;
    const callback = resizeCallbacks.get(content)!;
    await act(async () => callback([], {} as ResizeObserver));
    expect(getViewport().scrollTop).toBe(1200);
  });

  test("attaches growth follow when the viewport mounts one tick after its provider", async () => {
    const view = (viewportMounted: boolean) => (
      <MessageScrollerProvider scrollAnchor="bottom">
        {viewportMounted ?
          (
            <MessageScrollerViewport>
              <MessageScrollerContent>
                <MessageScrollerItem messageId="m1">hello</MessageScrollerItem>
              </MessageScrollerContent>
            </MessageScrollerViewport>
          ) :
          <span>loading</span>}
      </MessageScrollerProvider>
    );
    await renderWithLateViewport(view, { scrollHeight: 1000, clientHeight: 200, scrollTop: 0 });
    const content = container!.querySelector('[data-slot="message-scroller-content"]')!;
    const callback = resizeCallbacks.get(content);
    expect(callback).toBeDefined();

    metrics().scrollHeight = 1200;
    await act(async () => callback!([], {} as ResizeObserver));
    expect(getViewport().scrollTop).toBe(1200);
  });

  test("roots visibility tracking in a viewport that mounts one tick late", async () => {
    const originalIntersectionObserver = globalThis.IntersectionObserver;
    const roots: Array<Element | Document | null> = [];
    class RecordingIntersectionObserver implements IntersectionObserver {
      readonly root: Element | Document | null;
      readonly rootMargin = "0px";
      readonly thresholds = [0, 0.5];
      constructor(_callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
        this.root = options?.root ?? null;
        roots.push(this.root);
      }
      disconnect(): void {}
      observe(): void {}
      takeRecords(): IntersectionObserverEntry[] {
        return [];
      }
      unobserve(): void {}
    }
    globalThis.IntersectionObserver = RecordingIntersectionObserver;
    try {
      const view = (viewportMounted: boolean) => (
        <MessageScrollerProvider>
          {viewportMounted ?
            (
              <MessageScrollerViewport>
                <MessageScrollerContent>
                  <MessageScrollerItem messageId="m1">hello</MessageScrollerItem>
                </MessageScrollerContent>
              </MessageScrollerViewport>
            ) :
            <span>loading</span>}
        </MessageScrollerProvider>
      );
      await renderWithLateViewport(view, { scrollHeight: 1000, clientHeight: 200, scrollTop: 0 });
      expect(roots.at(-1)).toBe(getViewport());
    } finally {
      globalThis.IntersectionObserver = originalIntersectionObserver;
    }
  });

  test("scrollAnchor 'none' (the upstream default) never autoscrolls", async () => {
    await render(
      <MessageScrollerProvider>
        <MessageScrollerViewport>
          <MessageScrollerContent>
            <MessageScrollerItem messageId="m1">hello</MessageScrollerItem>
          </MessageScrollerContent>
        </MessageScrollerViewport>
      </MessageScrollerProvider>,
      { scrollHeight: 1000, clientHeight: 200, scrollTop: 300 },
    );
    expect(getViewport().scrollTop).toBe(300);
  });

  test("initialMessageId restores with the previous-item peek at mount", async () => {
    geometryByMessageId.set("target", { top: 300, height: 80 });
    await render(
      <MessageScrollerProvider scrollAnchor="bottom" initialMessageId="target">
        <MessageScrollerViewport>
          <MessageScrollerContent>
            <MessageScrollerItem messageId="older">older</MessageScrollerItem>
            <MessageScrollerItem messageId="target">target</MessageScrollerItem>
          </MessageScrollerContent>
        </MessageScrollerViewport>
      </MessageScrollerProvider>,
      { scrollHeight: 1000, clientHeight: 200, scrollTop: 0 },
    );
    expect(getViewport().scrollTop).toBe(300 - 56);
  });

  test("a missing initialMessageId falls back to the anchor and retries on registration", async () => {
    const view = (withTarget: boolean) => (
      <MessageScrollerProvider scrollAnchor="bottom" initialMessageId="target">
        <MessageScrollerViewport>
          <MessageScrollerContent>
            <MessageScrollerItem messageId="older">older</MessageScrollerItem>
            {withTarget ? <MessageScrollerItem messageId="target">target</MessageScrollerItem> : null}
          </MessageScrollerContent>
        </MessageScrollerViewport>
      </MessageScrollerProvider>
    );
    await render(view(false), { scrollHeight: 1000, clientHeight: 200, scrollTop: 0 });
    expect(getViewport().scrollTop).toBe(1000);
    geometryByMessageId.set("target", { top: 300, height: 80 });
    await act(async () => root!.render(view(true)));
    expect(getViewport().scrollTop).toBe(300 - 56);
  });

  test("scrollToMessage returns false for unregistered ids and jumps with peek", async () => {
    let commands: MessageScrollerCommands | undefined;
    function Probe() {
      commands = useMessageScroller();
      return null;
    }
    geometryByMessageId.set("m2", { top: 420, height: 80 });
    await render(
      <MessageScrollerProvider>
        <MessageScrollerViewport>
          <MessageScrollerContent>
            <MessageScrollerItem messageId="m1">one</MessageScrollerItem>
            <MessageScrollerItem messageId="m2">two</MessageScrollerItem>
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <Probe />
      </MessageScrollerProvider>,
      { scrollHeight: 1000, clientHeight: 200, scrollTop: 0 },
    );
    let result = false;
    await act(async () => {
      result = commands!.scrollToMessage("missing");
    });
    expect(result).toBe(false);
    await act(async () => {
      result = commands!.scrollToMessage("m2");
    });
    expect(result).toBe(true);
    expect(getViewport().scrollTop).toBe(420 - 56);
    await act(async () => {
      commands!.scrollToMessage("m2", { peek: false });
    });
    expect(getViewport().scrollTop).toBe(420);
  });

  test("jump/restore targets are independent of page layout (viewport is not an offsetParent)", async () => {
    let commands: MessageScrollerCommands | undefined;
    function Probe() {
      commands = useMessageScroller();
      return null;
    }
    pageOffset = 240;
    geometryByMessageId.set("m2", { top: 420, height: 80 });
    await render(
      <MessageScrollerProvider>
        <MessageScrollerViewport>
          <MessageScrollerContent>
            <MessageScrollerItem messageId="m1">one</MessageScrollerItem>
            <MessageScrollerItem messageId="m2">two</MessageScrollerItem>
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <Probe />
      </MessageScrollerProvider>,
      { scrollHeight: 1000, clientHeight: 200, scrollTop: 0 },
    );
    // Real-browser layout: the viewport is statically positioned, so the
    // item's offsetParent is a higher ancestor (here body) and offsetTop
    // resolves in document space (page offset included).
    const item = getItem("m2");
    Object.defineProperty(item, "offsetTop", { configurable: true, get: () => 240 + 420 });
    Object.defineProperty(item, "offsetParent", { configurable: true, get: () => document.body });
    let result = false;
    await act(async () => {
      result = commands!.scrollToMessage("m2");
    });
    expect(result).toBe(true);
    expect(getViewport().scrollTop).toBe(420 - 56);
  });

  test("a pending restore is cancelled by the first user scroll gesture", async () => {
    const view = (withTarget: boolean) => (
      <MessageScrollerProvider scrollAnchor="bottom" initialMessageId="target">
        <MessageScrollerViewport>
          <MessageScrollerContent>
            <MessageScrollerItem messageId="older">older</MessageScrollerItem>
            {withTarget ? <MessageScrollerItem messageId="target">target</MessageScrollerItem> : null}
          </MessageScrollerContent>
        </MessageScrollerViewport>
      </MessageScrollerProvider>
    );
    await render(view(false), { scrollHeight: 1000, clientHeight: 200, scrollTop: 0 });
    expect(getViewport().scrollTop).toBe(1000);
    // Scrollbar-drag style gesture: a bare scroll event away from the anchor.
    metrics().scrollTop = 400;
    await scroll();
    geometryByMessageId.set("target", { top: 300, height: 80 });
    await act(async () => root!.render(view(true)));
    expect(getViewport().scrollTop).toBe(400);
  });

  test("jumping to a mid-transcript message disengages follow; later commits do not yank to bottom", async () => {
    let commands: MessageScrollerCommands | undefined;
    let latestState: { atTop: boolean; atBottom: boolean; following: boolean; } | undefined;
    function Probe() {
      commands = useMessageScroller();
      latestState = useMessageScrollerState();
      return null;
    }
    geometryByMessageId.set("m2", { top: 500, height: 80 });
    const view = (
      <MessageScrollerProvider scrollAnchor="bottom">
        <MessageScrollerViewport>
          <MessageScrollerContent>
            <MessageScrollerItem messageId="m1">one</MessageScrollerItem>
            <MessageScrollerItem messageId="m2">two</MessageScrollerItem>
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <Probe />
      </MessageScrollerProvider>
    );
    await render(view, { scrollHeight: 1000, clientHeight: 200, scrollTop: 0 });
    expect(getViewport().scrollTop).toBe(1000);
    expect(latestState!.following).toBe(true);
    await act(async () => {
      commands!.scrollToMessage("m2");
    });
    expect(getViewport().scrollTop).toBe(500 - 56);
    expect(latestState!.following).toBe(false);
    // A later React commit must not re-pin the viewport to the bottom.
    await act(async () => root!.render(view));
    expect(getViewport().scrollTop).toBe(500 - 56);
  });

  test("jumping to a message at the very end clamps to the max scroll and keeps following", async () => {
    let commands: MessageScrollerCommands | undefined;
    let latestState: { atTop: boolean; atBottom: boolean; following: boolean; } | undefined;
    function Probe() {
      commands = useMessageScroller();
      latestState = useMessageScrollerState();
      return null;
    }
    geometryByMessageId.set("m2", { top: 880, height: 80 });
    await render(
      <MessageScrollerProvider scrollAnchor="bottom">
        <MessageScrollerViewport>
          <MessageScrollerContent>
            <MessageScrollerItem messageId="m1">one</MessageScrollerItem>
            <MessageScrollerItem messageId="m2">two</MessageScrollerItem>
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <Probe />
      </MessageScrollerProvider>,
      { scrollHeight: 1000, clientHeight: 200, scrollTop: 0 },
    );
    metrics().scrollTop = 300;
    await scroll();
    expect(latestState!.following).toBe(false);
    await act(async () => {
      commands!.scrollToMessage("m2");
    });
    expect(getViewport().scrollTop).toBe(800);
    expect(latestState!.following).toBe(true);
  });

  test("scrollToTop/scrollToBottom drive the viewport through commands", async () => {
    let commands: MessageScrollerCommands | undefined;
    function Probe() {
      commands = useMessageScroller();
      return null;
    }
    await render(
      <MessageScrollerProvider>
        <MessageScrollerViewport>
          <MessageScrollerContent>
            <MessageScrollerItem messageId="m1">one</MessageScrollerItem>
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <Probe />
      </MessageScrollerProvider>,
      { scrollHeight: 1000, clientHeight: 200, scrollTop: 300 },
    );
    await act(async () => commands!.scrollToBottom());
    expect(getViewport().scrollTop).toBe(1000);
    await act(async () => commands!.scrollToTop());
    expect(getViewport().scrollTop).toBe(0);
  });

  test("prepended items preserve position while not following", async () => {
    const view = (ids: string[]) => (
      <MessageScrollerProvider scrollAnchor="bottom">
        <MessageScrollerViewport>
          <MessageScrollerContent>
            {ids.map((id) => (
              <MessageScrollerItem key={id} messageId={id}>
                {id}
              </MessageScrollerItem>
            ))}
          </MessageScrollerContent>
        </MessageScrollerViewport>
      </MessageScrollerProvider>
    );
    await render(view(["a", "b"]), { scrollHeight: 1000, clientHeight: 200, scrollTop: 0 });
    metrics().scrollTop = 400;
    await scroll();
    metrics().scrollHeight = 1200;
    await act(async () => root!.render(view(["older", "a", "b"])));
    expect(getViewport().scrollTop).toBe(600);
  });

  test("useMessageVisibility falls back to geometry without IntersectionObserver", async () => {
    const intersectionObserver = globalThis.IntersectionObserver;
    globalThis.IntersectionObserver = undefined as unknown as typeof IntersectionObserver;
    const visible: Record<string, boolean> = {};
    function Probe() {
      visible.a = useMessageVisibility("a");
      visible.b = useMessageVisibility("b");
      return null;
    }
    geometryByMessageId.set("a", { top: 0, height: 100 });
    geometryByMessageId.set("b", { top: 900, height: 100 });
    try {
      await render(
        <MessageScrollerProvider>
          <MessageScrollerViewport>
            <MessageScrollerContent>
              <MessageScrollerItem messageId="a">a</MessageScrollerItem>
              <MessageScrollerItem messageId="b">b</MessageScrollerItem>
            </MessageScrollerContent>
          </MessageScrollerViewport>
          <Probe />
        </MessageScrollerProvider>,
        { scrollHeight: 1000, clientHeight: 200, scrollTop: 0 },
      );
      expect(visible.a).toBe(true);
      expect(visible.b).toBe(false);
      metrics().scrollTop = 850;
      await scroll();
      expect(visible.a).toBe(false);
      expect(visible.b).toBe(true);
    } finally {
      globalThis.IntersectionObserver = intersectionObserver;
    }
  });

  test("visibility treats an item filling the viewport as visible", async () => {
    const intersectionObserver = globalThis.IntersectionObserver;
    globalThis.IntersectionObserver = undefined as unknown as typeof IntersectionObserver;
    const visible: Record<string, boolean> = {};
    function Probe() {
      visible.big = useMessageVisibility("big");
      return null;
    }
    geometryByMessageId.set("big", { top: 0, height: 2000 });
    try {
      await render(
        <MessageScrollerProvider>
          <MessageScrollerViewport>
            <MessageScrollerContent>
              <MessageScrollerItem messageId="big">big</MessageScrollerItem>
            </MessageScrollerContent>
          </MessageScrollerViewport>
          <Probe />
        </MessageScrollerProvider>,
        { scrollHeight: 2000, clientHeight: 200, scrollTop: 100 },
      );
      expect(visible.big).toBe(true);
    } finally {
      globalThis.IntersectionObserver = intersectionObserver;
    }
  });

  test("MessageScrollerButton stays rendered but inert at the latest position and jumps on click", async () => {
    await render(
      <MessageScrollerProvider scrollAnchor="bottom">
        <MessageScrollerViewport>
          <MessageScrollerContent>
            <MessageScrollerItem messageId="m1">one</MessageScrollerItem>
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <MessageScrollerButton behavior="auto" />
      </MessageScrollerProvider>,
      { scrollHeight: 1000, clientHeight: 200, scrollTop: 0 },
    );
    // Frozen contract: the button is a real element that goes inert (no focus
    // stop, data-active=false) while there is nothing to scroll toward.
    const button = container!.querySelector<HTMLButtonElement>('[data-slot="message-scroller-button"]')!;
    expect(button).not.toBeNull();
    expect(button.getAttribute("data-active")).toBe("false");
    expect(button.getAttribute("data-target")).toBe("end");
    expect(button.hasAttribute("inert")).toBe(true);
    expect(button.tabIndex).toBe(-1);
    metrics().scrollTop = 200;
    await scroll();
    expect(button.getAttribute("data-active")).toBe("true");
    expect(button.hasAttribute("inert")).toBe(false);
    expect(button.tabIndex).toBe(0);
    await act(async () => button.click());
    expect(getViewport().scrollTop).toBe(1000);
    expect(button.getAttribute("data-active")).toBe("false");
  });

  test("a start-targeted button is inert at the top and scrolls to the start", async () => {
    await render(
      <MessageScrollerProvider>
        <MessageScrollerViewport>
          <MessageScrollerContent>
            <MessageScrollerItem messageId="m1">one</MessageScrollerItem>
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <MessageScrollerButton target="start" behavior="auto" />
      </MessageScrollerProvider>,
      { scrollHeight: 1000, clientHeight: 200, scrollTop: 500 },
    );
    const button = container!.querySelector<HTMLButtonElement>('[data-slot="message-scroller-button"]')!;
    expect(button.getAttribute("data-target")).toBe("start");
    expect(button.getAttribute("data-active")).toBe("true");
    await act(async () => button.click());
    expect(getViewport().scrollTop).toBe(0);
    expect(button.getAttribute("data-active")).toBe("false");
    expect(button.hasAttribute("inert")).toBe(true);
    expect(button.tabIndex).toBe(-1);
  });

  test("a message-targeted button goes inert while its message is visible", async () => {
    const intersectionObserver = globalThis.IntersectionObserver;
    globalThis.IntersectionObserver = undefined as unknown as typeof IntersectionObserver;
    geometryByMessageId.set("m2", { top: 700, height: 100 });
    try {
      await render(
        <MessageScrollerProvider>
          <MessageScrollerViewport>
            <MessageScrollerContent>
              <MessageScrollerItem messageId="m1">one</MessageScrollerItem>
              <MessageScrollerItem messageId="m2">two</MessageScrollerItem>
            </MessageScrollerContent>
          </MessageScrollerViewport>
          <MessageScrollerButton target={{ messageId: "m2" }} behavior="auto" />
        </MessageScrollerProvider>,
        { scrollHeight: 1000, clientHeight: 200, scrollTop: 0 },
      );
      const button = container!.querySelector<HTMLButtonElement>('[data-slot="message-scroller-button"]')!;
      expect(button.getAttribute("data-active")).toBe("true");
      await act(async () => button.click());
      expect(getViewport().scrollTop).toBe(700 - 56);
      // The jump scrolls the message into view: the affordance goes inert.
      expect(button.getAttribute("data-active")).toBe("false");
      expect(button.hasAttribute("inert")).toBe(true);
    } finally {
      globalThis.IntersectionObserver = intersectionObserver;
    }
  });

  test("renders under the dark theme", async () => {
    installDarkThemeStyles();
    document.documentElement.dataset.theme = "dark";
    await render(
      <MessageScrollerProvider>
        <MessageScrollerViewport>
          <MessageScrollerContent>
            <MessageScrollerItem messageId="m1">dark</MessageScrollerItem>
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <MessageScrollerButton behavior="auto" />
      </MessageScrollerProvider>,
      { scrollHeight: 1000, clientHeight: 200, scrollTop: 50 },
    );
    const button = container!.querySelector<HTMLElement>('[data-slot="message-scroller-button"]')!;
    expect(getComputedStyle(button).color).toBe("#ece7db");
  });

  test("the compound anatomy shares one provider and viewport", async () => {
    let commands: MessageScrollerCommands | undefined;
    let latestState: { atTop: boolean; atBottom: boolean; following: boolean; } | undefined;
    function Probe() {
      commands = useMessageScroller();
      latestState = useMessageScrollerState();
      return null;
    }
    geometryByMessageId.set("m1", { top: 0, height: 500 });
    geometryByMessageId.set("m2", { top: 500, height: 500 });
    await render(
      <MessageScrollerProvider scrollAnchor="bottom">
        <div data-slot="message-scroller">
          <MessageScrollerViewport>
            <MessageScrollerContent>
              <MessageScrollerItem messageId="m1" scrollAnchor>
                one
              </MessageScrollerItem>
              <MessageScrollerItem messageId="m2">two</MessageScrollerItem>
            </MessageScrollerContent>
          </MessageScrollerViewport>
          <MessageScrollerButton behavior="auto" />
        </div>
        <Probe />
      </MessageScrollerProvider>,
      { scrollHeight: 1000, clientHeight: 200, scrollTop: 0 },
    );
    // The frame groups compound parts around a single provider-owned viewport.
    const frames = container!.querySelectorAll<HTMLElement>('[data-slot="message-scroller"]');
    expect(frames).toHaveLength(1);
    expect(container!.querySelectorAll('[data-slot="message-scroller-viewport"]')).toHaveLength(1);
    const frame = frames[0]!;
    expect(frame.contains(getViewport())).toBe(true);
    expect(frame.querySelector('[data-slot="message-scroller-button"]')).not.toBeNull();
    expect(getViewport().scrollTop).toBe(1000);
    expect(latestState!.following).toBe(true);
    // The jump affordance lives in the frame and drives the ambient viewport.
    const button = frame.querySelector<HTMLButtonElement>('[data-slot="message-scroller-button"]')!;
    expect(button.getAttribute("data-active")).toBe("false");
    metrics().scrollTop = 300;
    await scroll();
    expect(latestState!.following).toBe(false);
    expect(button.getAttribute("data-active")).toBe("true");
    await act(async () => button.click());
    expect(getViewport().scrollTop).toBe(1000);
    expect(latestState!.following).toBe(true);
    // Commands drive the same viewport through the compound parts.
    await act(async () => {
      commands!.scrollToMessage("m2", { peek: false });
    });
    expect(getViewport().scrollTop).toBe(500);
    expect(latestState!.following).toBe(false);
    await act(async () => commands!.scrollToBottom());
    expect(getViewport().scrollTop).toBe(1000);
    expect(latestState!.following).toBe(true);
  });

  test("fade options reach compound viewports", async () => {
    await render(
      <>
        <MessageScrollerProvider>
          <div data-testid="without-fade"><MessageScrollerViewport fade={false} /></div>
        </MessageScrollerProvider>
        <MessageScrollerProvider>
          <div data-testid="with-fade"><MessageScrollerViewport fade /></div>
        </MessageScrollerProvider>
      </>,
      { scrollHeight: 1000, clientHeight: 200, scrollTop: 0 },
    );

    const withoutFade = container!.querySelector<HTMLElement>('[data-testid="without-fade"]')!;
    const withFade = container!.querySelector<HTMLElement>('[data-testid="with-fade"]')!;
    expect(withoutFade.querySelector('[data-slot="message-scroller-viewport"]')!.classList).not.toContain(
      "sui-scroll-fade",
    );
    expect(withFade.querySelector('[data-slot="message-scroller-viewport"]')!.classList).toContain(
      "sui-scroll-fade",
    );
  });

  test("a latest button can be omitted by the compound caller", async () => {
    await render(
      <>
        <MessageScrollerProvider>
          <div data-testid="without-button"><MessageScrollerViewport /></div>
        </MessageScrollerProvider>
      </>,
      { scrollHeight: 1000, clientHeight: 200, scrollTop: 0 },
    );

    expect(container!.querySelector('[data-testid="without-button"] [data-slot="message-scroller-button"]')).toBeNull();
  });

  test("aria-label customizes the latest button", async () => {
    await render(
      <>
        <MessageScrollerProvider>
          <div data-testid="custom-label">
            <MessageScrollerViewport />
            <MessageScrollerButton aria-label="Go" />
          </div>
        </MessageScrollerProvider>
      </>,
      { scrollHeight: 1000, clientHeight: 200, scrollTop: 0 },
    );

    expect(
      container!.querySelector('[data-testid="custom-label"] [data-slot="message-scroller-button"]')!.getAttribute(
        "aria-label",
      ),
    ).toBe("Go");
  });

  test("className reaches compound content", async () => {
    await render(
      <>
        <MessageScrollerProvider>
          <div data-testid="custom-content">
            <MessageScrollerViewport>
              <MessageScrollerContent className="x" />
            </MessageScrollerViewport>
          </div>
        </MessageScrollerProvider>
      </>,
      { scrollHeight: 1000, clientHeight: 200, scrollTop: 0 },
    );

    expect(
      container!.querySelector('[data-testid="custom-content"] [data-slot="message-scroller-content"]')!.classList,
    ).toContain("x");
  });

  test("the viewport exposes data-autoscrolling only while a programmatic jump runs", async () => {
    let commands: MessageScrollerCommands | undefined;
    function Probe() {
      commands = useMessageScroller();
      return null;
    }
    await render(
      <MessageScrollerProvider scrollAnchor="bottom">
        <div data-slot="message-scroller">
          <MessageScrollerViewport>
            <MessageScrollerContent>
              <MessageScrollerItem messageId="m1">one</MessageScrollerItem>
            </MessageScrollerContent>
          </MessageScrollerViewport>
        </div>
        <Probe />
      </MessageScrollerProvider>,
      { scrollHeight: 1000, clientHeight: 200, scrollTop: 0 },
    );
    const viewport = getViewport();
    expect(viewport.hasAttribute("data-autoscrolling")).toBe(false);
    metrics().scrollTop = 300;
    await scroll();
    // A smooth scroll mid-animation: advanced partway, not yet settled.
    const originalScrollTo = viewport.scrollTo;
    Object.defineProperty(viewport, "scrollTo", {
      configurable: true,
      value: ({ top }: { top: number; }) => {
        metrics().scrollTop = Math.min(top, 600);
      },
    });
    await act(async () => commands!.scrollToBottom("smooth"));
    Object.defineProperty(viewport, "scrollTo", { configurable: true, value: originalScrollTo });
    expect(viewport.getAttribute("data-autoscrolling")).toBe("true");
    // The jump settles: the attribute clears and follow reconciles.
    await act(async () => viewport.dispatchEvent(new Event("scrollend")));
    expect(viewport.hasAttribute("data-autoscrolling")).toBe(false);
    // Landed jumps never raise the attribute at all.
    await act(async () => commands!.scrollToBottom("auto"));
    expect(viewport.hasAttribute("data-autoscrolling")).toBe(false);
  });

  test("a forward scrollbar drag that stops short reconciles on scrollend instead of hijacking growth", async () => {
    let commands: MessageScrollerCommands | undefined;
    let latestState: { atTop: boolean; atBottom: boolean; following: boolean; } | undefined;
    function Probe() {
      commands = useMessageScroller();
      latestState = useMessageScrollerState();
      return null;
    }
    await render(
      <MessageScrollerProvider scrollAnchor="bottom">
        <MessageScrollerViewport>
          <MessageScrollerContent>
            <MessageScrollerItem messageId="m1">one</MessageScrollerItem>
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <Probe />
      </MessageScrollerProvider>,
      { scrollHeight: 1000, clientHeight: 200, scrollTop: 0 },
    );
    metrics().scrollTop = 300;
    await scroll();
    expect(latestState!.following).toBe(false);
    const viewport = getViewport();
    const originalScrollTo = viewport.scrollTo;
    Object.defineProperty(viewport, "scrollTo", {
      configurable: true,
      value: ({ top }: { top: number; }) => {
        metrics().scrollTop = Math.min(top, 600);
      },
    });
    await act(async () => commands!.scrollToBottom("smooth"));
    Object.defineProperty(viewport, "scrollTo", { configurable: true, value: originalScrollTo });
    // The reader takes the scrollbar and drags downward, but stops short of
    // the bottom: forward scroll events cannot tell this from animation
    // frames, so the jump stays tracked until the gesture ends.
    metrics().scrollTop = 700;
    await scroll();
    await act(async () => viewport.dispatchEvent(new Event("scrollend")));
    expect(latestState!.following).toBe(false);
    // Growth after the interrupted jump must not yank the reader to the bottom.
    metrics().scrollHeight = 1600;
    const content = container!.querySelector('[data-slot="message-scroller-content"]')!;
    await act(async () => resizeCallbacks.get(content)!([], {} as ResizeObserver));
    expect(getViewport().scrollTop).toBe(700);
    expect(latestState!.following).toBe(false);
  });

  test("scrollend that lands at the bottom re-engages follow", async () => {
    let commands: MessageScrollerCommands | undefined;
    let latestState: { atTop: boolean; atBottom: boolean; following: boolean; } | undefined;
    function Probe() {
      commands = useMessageScroller();
      latestState = useMessageScrollerState();
      return null;
    }
    await render(
      <MessageScrollerProvider scrollAnchor="bottom">
        <MessageScrollerViewport>
          <MessageScrollerContent>
            <MessageScrollerItem messageId="m1">one</MessageScrollerItem>
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <Probe />
      </MessageScrollerProvider>,
      { scrollHeight: 1000, clientHeight: 200, scrollTop: 0 },
    );
    metrics().scrollTop = 300;
    await scroll();
    expect(latestState!.following).toBe(false);
    const viewport = getViewport();
    const originalScrollTo = viewport.scrollTo;
    Object.defineProperty(viewport, "scrollTo", {
      configurable: true,
      value: () => {
        /* smooth animation delivers no synchronous position */
      },
    });
    await act(async () => commands!.scrollToBottom("smooth"));
    Object.defineProperty(viewport, "scrollTo", { configurable: true, value: originalScrollTo });
    expect(latestState!.following).toBe(false);
    // The animation completes at the live edge; when the environment delivers
    // only scrollend (no trailing scroll event), follow still reconciles.
    metrics().scrollTop = 800;
    await act(async () => viewport.dispatchEvent(new Event("scrollend")));
    expect(latestState!.following).toBe(true);
  });

  test("a newly appended scrollAnchor row anchors the turn near the top and lets follow take over once the reply fills the viewport", async () => {
    let latestState: { atTop: boolean; atBottom: boolean; following: boolean; } | undefined;
    function Probe() {
      latestState = useMessageScrollerState();
      return null;
    }
    geometryByMessageId.set("m1", { top: 0, height: 2000 });
    const view = (withTurn: boolean) => (
      <MessageScrollerProvider scrollAnchor="bottom">
        <MessageScrollerViewport>
          <MessageScrollerContent>
            <MessageScrollerItem messageId="m1">history</MessageScrollerItem>
            {withTurn ?
              (
                <>
                  <MessageScrollerItem messageId="q" scrollAnchor>
                    question
                  </MessageScrollerItem>
                  <MessageScrollerItem messageId="a">answer</MessageScrollerItem>
                </>
              ) :
              null}
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <Probe />
      </MessageScrollerProvider>
    );
    await render(view(false), { scrollHeight: 2000, clientHeight: 200, scrollTop: 0 });
    expect(getViewport().scrollTop).toBe(2000);
    expect(latestState!.following).toBe(true);
    // A new turn arrives: the question row starts where the content used to
    // end, and the turn is tall enough to anchor above the bottom region.
    metrics().scrollHeight = 2460;
    geometryByMessageId.set("q", { top: 2000, height: 60 });
    geometryByMessageId.set("a", { top: 2060, height: 400 });
    await act(async () => root!.render(view(true)));
    // Anchored near the top with the previous-item peek; follow releases.
    expect(getViewport().scrollTop).toBe(2000 - 56);
    expect(latestState!.following).toBe(false);
    // A later React commit must not yank the anchored viewport to the bottom.
    await act(async () => root!.render(view(true)));
    expect(getViewport().scrollTop).toBe(2000 - 56);
    // The reply keeps streaming past the viewport: follow takes over and later
    // growth pins to the live edge again.
    metrics().scrollHeight = 2600;
    geometryByMessageId.set("a", { top: 2060, height: 540 });
    const content = container!.querySelector('[data-slot="message-scroller-content"]')!;
    await act(async () => resizeCallbacks.get(content)!([], {} as ResizeObserver));
    expect(latestState!.following).toBe(true);
    metrics().scrollHeight = 2800;
    geometryByMessageId.set("a", { top: 2060, height: 740 });
    await act(async () => resizeCallbacks.get(content)!([], {} as ResizeObserver));
    expect(getViewport().scrollTop).toBe(2800);
  });

  test("a short appended scrollAnchor turn clamps to the live edge and keeps following", async () => {
    let latestState: { atTop: boolean; atBottom: boolean; following: boolean; } | undefined;
    function Probe() {
      latestState = useMessageScrollerState();
      return null;
    }
    geometryByMessageId.set("m1", { top: 0, height: 2000 });
    const view = (withTurn: boolean) => (
      <MessageScrollerProvider scrollAnchor="bottom">
        <MessageScrollerViewport>
          <MessageScrollerContent>
            <MessageScrollerItem messageId="m1">history</MessageScrollerItem>
            {withTurn ?
              (
                <>
                  <MessageScrollerItem messageId="q" scrollAnchor>
                    question
                  </MessageScrollerItem>
                  <MessageScrollerItem messageId="a">answer</MessageScrollerItem>
                </>
              ) :
              null}
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <Probe />
      </MessageScrollerProvider>
    );
    await render(view(false), { scrollHeight: 2000, clientHeight: 200, scrollTop: 0 });
    // The new turn is too short to sit above the bottom region: the anchor
    // falls back to the live edge, exactly like upstream's end fallback.
    metrics().scrollHeight = 2100;
    geometryByMessageId.set("q", { top: 2000, height: 60 });
    geometryByMessageId.set("a", { top: 2060, height: 40 });
    await act(async () => root!.render(view(true)));
    expect(getViewport().scrollTop).toBe(2100);
    expect(latestState!.following).toBe(true);
  });

  test("scrollAnchor rows present on the initial mount do not anchor turns", async () => {
    geometryByMessageId.set("m1", { top: 0, height: 500 });
    geometryByMessageId.set("m2", { top: 500, height: 500 });
    await render(
      <MessageScrollerProvider scrollAnchor="bottom">
        <MessageScrollerViewport>
          <MessageScrollerContent>
            <MessageScrollerItem messageId="m1" scrollAnchor>
              one
            </MessageScrollerItem>
            <MessageScrollerItem messageId="m2" scrollAnchor>
              two
            </MessageScrollerItem>
          </MessageScrollerContent>
        </MessageScrollerViewport>
      </MessageScrollerProvider>,
      { scrollHeight: 1000, clientHeight: 200, scrollTop: 0 },
    );
    // Mount pinning wins: no turn-anchor move for rows that were always there.
    expect(getViewport().scrollTop).toBe(1000);
  });

  test("scrollToMessage queues a permalink jump until its row registers", async () => {
    let commands: MessageScrollerCommands | undefined;
    function Probe() {
      commands = useMessageScroller();
      return null;
    }
    const view = (withItems: boolean) => (
      <MessageScrollerProvider>
        <MessageScrollerViewport>
          <MessageScrollerContent>
            {withItems ?
              (
                <>
                  <MessageScrollerItem messageId="m1">one</MessageScrollerItem>
                  <MessageScrollerItem messageId="m2">two</MessageScrollerItem>
                </>
              ) :
              null}
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <Probe />
      </MessageScrollerProvider>
    );
    await render(view(false), { scrollHeight: 1000, clientHeight: 200, scrollTop: 0 });
    // No rows mounted yet: the jump queues and reports true.
    let result = false;
    await act(async () => {
      result = commands!.scrollToMessage("m2", { peek: false });
    });
    expect(result).toBe(true);
    expect(getViewport().scrollTop).toBe(0);
    geometryByMessageId.set("m2", { top: 420, height: 80 });
    await act(async () => root!.render(view(true)));
    expect(getViewport().scrollTop).toBe(420);
  });

  test("a smooth jump-to-latest re-targets the bottom when content grows mid-flight", async () => {
    let commands: MessageScrollerCommands | undefined;
    let latestState: { atTop: boolean; atBottom: boolean; following: boolean; } | undefined;
    function Probe() {
      commands = useMessageScroller();
      latestState = useMessageScrollerState();
      return null;
    }
    await render(
      <MessageScrollerProvider scrollAnchor="bottom">
        <MessageScrollerViewport>
          <MessageScrollerContent>
            <MessageScrollerItem messageId="m1">one</MessageScrollerItem>
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <Probe />
      </MessageScrollerProvider>,
      { scrollHeight: 1000, clientHeight: 200, scrollTop: 0 },
    );
    expect(getViewport().scrollTop).toBe(1000);
    metrics().scrollTop = 300;
    await scroll();
    expect(latestState!.following).toBe(false);
    // A smooth scroll mid-animation: advanced partway, not yet settled.
    const viewport = getViewport();
    const originalScrollTo = viewport.scrollTo;
    Object.defineProperty(viewport, "scrollTo", {
      configurable: true,
      value: ({ top }: { top: number; }) => {
        metrics().scrollTop = Math.min(top, 600);
      },
    });
    await act(async () => commands!.scrollToBottom("smooth"));
    Object.defineProperty(viewport, "scrollTo", { configurable: true, value: originalScrollTo });
    expect(getViewport().scrollTop).toBe(600);
    // Streaming growth mid-flight must not strand the jump: it re-targets the
    // moving bottom and re-engages follow once it lands.
    metrics().scrollHeight = 1600;
    const content = container!.querySelector('[data-slot="message-scroller-content"]')!;
    await act(async () => resizeCallbacks.get(content)!([], {} as ResizeObserver));
    expect(getViewport().scrollTop).toBe(1600);
    expect(latestState!.following).toBe(true);
  });

  test("a backward scrollbar drag mid-flight cancels the jump and stops re-targeting", async () => {
    let commands: MessageScrollerCommands | undefined;
    let latestState: { atTop: boolean; atBottom: boolean; following: boolean; } | undefined;
    function Probe() {
      commands = useMessageScroller();
      latestState = useMessageScrollerState();
      return null;
    }
    await render(
      <MessageScrollerProvider scrollAnchor="bottom">
        <MessageScrollerViewport>
          <MessageScrollerContent>
            <MessageScrollerItem messageId="m1">one</MessageScrollerItem>
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <Probe />
      </MessageScrollerProvider>,
      { scrollHeight: 1000, clientHeight: 200, scrollTop: 0 },
    );
    metrics().scrollTop = 300;
    await scroll();
    expect(latestState!.following).toBe(false);
    const viewport = getViewport();
    const originalScrollTo = viewport.scrollTo;
    Object.defineProperty(viewport, "scrollTo", {
      configurable: true,
      value: ({ top }: { top: number; }) => {
        metrics().scrollTop = Math.min(top, 600);
      },
    });
    await act(async () => commands!.scrollToBottom("smooth"));
    Object.defineProperty(viewport, "scrollTo", { configurable: true, value: originalScrollTo });
    // Scrollbar drags surface only as scroll events: dragging upward mid-flight
    // is a user interruption and cancels the programmatic jump.
    metrics().scrollTop = 400;
    await scroll();
    metrics().scrollHeight = 1600;
    const content = container!.querySelector('[data-slot="message-scroller-content"]')!;
    await act(async () => resizeCallbacks.get(content)!([], {} as ResizeObserver));
    expect(getViewport().scrollTop).toBe(400);
    expect(latestState!.following).toBe(false);
  });

  test("a smooth jump to a bottom-region message survives mid-flight events and growth", async () => {
    let commands: MessageScrollerCommands | undefined;
    let latestState: { atTop: boolean; atBottom: boolean; following: boolean; } | undefined;
    function Probe() {
      commands = useMessageScroller();
      latestState = useMessageScrollerState();
      return null;
    }
    geometryByMessageId.set("m2", { top: 880, height: 80 });
    await render(
      <MessageScrollerProvider scrollAnchor="bottom">
        <MessageScrollerViewport>
          <MessageScrollerContent>
            <MessageScrollerItem messageId="m1">one</MessageScrollerItem>
            <MessageScrollerItem messageId="m2">two</MessageScrollerItem>
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <Probe />
      </MessageScrollerProvider>,
      { scrollHeight: 1000, clientHeight: 200, scrollTop: 0 },
    );
    metrics().scrollTop = 300;
    await scroll();
    expect(latestState!.following).toBe(false);
    // A smooth scroll mid-animation: advanced partway, not yet settled.
    const viewport = getViewport();
    const originalScrollTo = viewport.scrollTo;
    Object.defineProperty(viewport, "scrollTo", {
      configurable: true,
      value: ({ top }: { top: number; }) => {
        metrics().scrollTop = Math.min(top, 600);
      },
    });
    // The target clamps to the max scroll: this jump is a jump-to-latest.
    await act(async () => commands!.scrollToMessage("m2", { behavior: "smooth" }));
    Object.defineProperty(viewport, "scrollTo", { configurable: true, value: originalScrollTo });
    expect(getViewport().scrollTop).toBe(600);
    // Mid-flight animation events must not strand follow: the jump is tracked
    // until it lands, so growth re-targets the moving bottom.
    metrics().scrollTop = 650;
    await scroll();
    metrics().scrollHeight = 1600;
    const content = container!.querySelector('[data-slot="message-scroller-content"]')!;
    await act(async () => resizeCallbacks.get(content)!([], {} as ResizeObserver));
    expect(getViewport().scrollTop).toBe(1600);
    expect(latestState!.following).toBe(true);
  });

  test("a backward scrollbar drag cancels a smooth jump to a bottom-region message", async () => {
    let commands: MessageScrollerCommands | undefined;
    let latestState: { atTop: boolean; atBottom: boolean; following: boolean; } | undefined;
    function Probe() {
      commands = useMessageScroller();
      latestState = useMessageScrollerState();
      return null;
    }
    geometryByMessageId.set("m2", { top: 880, height: 80 });
    await render(
      <MessageScrollerProvider scrollAnchor="bottom">
        <MessageScrollerViewport>
          <MessageScrollerContent>
            <MessageScrollerItem messageId="m1">one</MessageScrollerItem>
            <MessageScrollerItem messageId="m2">two</MessageScrollerItem>
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <Probe />
      </MessageScrollerProvider>,
      { scrollHeight: 1000, clientHeight: 200, scrollTop: 0 },
    );
    metrics().scrollTop = 300;
    await scroll();
    const viewport = getViewport();
    const originalScrollTo = viewport.scrollTo;
    Object.defineProperty(viewport, "scrollTo", {
      configurable: true,
      value: ({ top }: { top: number; }) => {
        metrics().scrollTop = Math.min(top, 600);
      },
    });
    await act(async () => commands!.scrollToMessage("m2", { behavior: "smooth" }));
    Object.defineProperty(viewport, "scrollTo", { configurable: true, value: originalScrollTo });
    // Dragging upward mid-flight is a user interruption: cancel the jump, stop
    // re-targeting, and disengage follow.
    metrics().scrollTop = 400;
    await scroll();
    metrics().scrollHeight = 1600;
    const content = container!.querySelector('[data-slot="message-scroller-content"]')!;
    await act(async () => resizeCallbacks.get(content)!([], {} as ResizeObserver));
    expect(getViewport().scrollTop).toBe(400);
    expect(latestState!.following).toBe(false);
  });
});

describe("readable transcript following", () => {
  const view = (id: string, actor: "user" | "output" = "output") => (
    <MessageScrollerProvider scrollAnchor="bottom" initialMessageId="home" readAnchor={{ messageId: id, actor }}>
      <MessageScrollerViewport><MessageScrollerContent>
        <MessageScrollerItem messageId="home">Home</MessageScrollerItem>
        <MessageScrollerItem messageId={id}>New content</MessageScrollerItem>
      </MessageScrollerContent></MessageScrollerViewport>
      <MessageScrollerButton />
    </MessageScrollerProvider>
  );
  test("Home restore stays ready to follow a card, then manual scroll-up releases it", async () => {
    geometryByMessageId.set("home", { top: 20, height: 900 });
    geometryByMessageId.set("welcome", { top: 950, height: 100 });
    await render(view("welcome"), { scrollHeight: 1100, clientHeight: 600, scrollTop: 0 });
    expect(getViewport().scrollTop).toBe(10);
    geometryByMessageId.set("issues", { top: 1100, height: 900 });
    metrics().scrollHeight = 2000;
    await act(async () => root!.render(view("issues")));
    expect(getViewport().scrollTop).toBe(1090);
    metrics().scrollTop = 400;
    await scroll();
    geometryByMessageId.set("reply", { top: 2000, height: 100 });
    metrics().scrollHeight = 2100;
    await act(async () => root!.render(view("reply")));
    expect(getViewport().scrollTop).toBe(400);
    expect(container!.querySelector('[data-slot="message-scroller-button"]')!.getAttribute("data-active")).toBe("true");
    geometryByMessageId.set("sent", { top: 2100, height: 100 });
    metrics().scrollHeight = 2200;
    await act(async () => root!.render(view("sent", "user")));
    expect(getViewport().scrollTop).toBe(1600);
  });
  test("a Home heading stays anchored when its content grows asynchronously", async () => {
    geometryByMessageId.set("home", { top: 800, height: 900 });
    geometryByMessageId.set("welcome", { top: 1750, height: 100 });
    await render(view("welcome"), { scrollHeight: 1900, clientHeight: 600, scrollTop: 0 });
    geometryByMessageId.set("home", { top: 800, height: 1200 });
    metrics().scrollHeight = 2200;
    const content = container!.querySelector('[data-slot="message-scroller-content"]')!;
    await act(async () => resizeCallbacks.get(content)?.([], {} as ResizeObserver));
    expect(getViewport().scrollTop).toBe(790);
  });
});

test("a send batched with its reply resumes a released reader", async () => {
  const view = (id: string, userMessageId?: string) => <MessageScrollerProvider scrollAnchor="bottom"
    readAnchor={{ messageId: id, userMessageId }}>
    <MessageScrollerViewport><MessageScrollerContent>
      <MessageScrollerItem messageId={id}>Reply</MessageScrollerItem>
    </MessageScrollerContent></MessageScrollerViewport>
  </MessageScrollerProvider>;
  geometryByMessageId.set("old", { top: 1000, height: 100 });
  await render(view("old"), { scrollHeight: 1100, clientHeight: 600, scrollTop: 0 });
  metrics().scrollTop = 100;
  await scroll();
  geometryByMessageId.set("reply", { top: 1100, height: 100 });
  metrics().scrollHeight = 1200;
  await act(async () => root!.render(view("reply", "sent")));
  expect(getViewport().scrollTop).toBe(600);
});

test("a slash request waits for its new card before resuming follow", async () => {
  const view = (id: string, requestId: number) => <MessageScrollerProvider scrollAnchor="bottom"
    readAnchor={{ messageId: id, requestId }}>
    <MessageScrollerViewport><MessageScrollerContent>
      <MessageScrollerItem messageId={id}>Card</MessageScrollerItem>
    </MessageScrollerContent></MessageScrollerViewport>
  </MessageScrollerProvider>;
  geometryByMessageId.set("home", { top: 20, height: 1000 });
  await render(view("home", 0), { scrollHeight: 1100, clientHeight: 600, scrollTop: 0 });
  metrics().scrollTop = 100;
  await scroll();
  await act(async () => root!.render(view("home", 1)));
  expect(getViewport().scrollTop).toBe(100);
  geometryByMessageId.set("issues", { top: 1100, height: 200 });
  metrics().scrollHeight = 1300;
  await act(async () => root!.render(view("issues", 1)));
  expect(getViewport().scrollTop).toBe(700);
});

test.each(["wheel", "ArrowDown", "PageDown", "End"])("%s at the bottom keeps following new messages", async (input) => {
  const view = (id: string) => <MessageScrollerProvider scrollAnchor="bottom" readAnchor={{ messageId: id }}>
    <MessageScrollerViewport><MessageScrollerContent>
      <MessageScrollerItem messageId={id}>Reply</MessageScrollerItem>
    </MessageScrollerContent></MessageScrollerViewport>
  </MessageScrollerProvider>;
  geometryByMessageId.set("reply", { top: 1000, height: 100 });
  await render(view("reply"), { scrollHeight: 1100, clientHeight: 600, scrollTop: 0 });
  expect(getViewport().scrollTop).toBe(500);
  await act(async () => getViewport().dispatchEvent(input === "wheel"
    ? new WheelEvent("wheel", { deltaY: 100, bubbles: true })
    : new KeyboardEvent("keydown", { key: input, bubbles: true })));
  // A gesture against the bottom boundary produces no scroll event.
  geometryByMessageId.set("reply", { top: 1000, height: 200 });
  metrics().scrollHeight = 1200;
  const content = container!.querySelector('[data-slot="message-scroller-content"]')!;
  await act(async () => resizeCallbacks.get(content)!([], {} as ResizeObserver));
  expect(getViewport().scrollTop).toBe(600);
  geometryByMessageId.set("next", { top: 1200, height: 100 });
  metrics().scrollHeight = 1300;
  await act(async () => root!.render(view("next")));
  expect(getViewport().scrollTop).toBe(700);
  // Upward intent must still release follow before its scroll event arrives.
  await act(async () => getViewport().dispatchEvent(new WheelEvent("wheel", { deltaY: -100, bubbles: true })));
  metrics().scrollHeight = 1400;
  await act(async () => resizeCallbacks.get(content)!([], {} as ResizeObserver));
  expect(getViewport().scrollTop).toBe(700);
});

test("late Home hydration respects a scroll-up after Welcome was painted", async () => {
  const view = (id: string) => <MessageScrollerProvider scrollAnchor="bottom"
    readAnchor={{ messageId: id, actor: "arrival" }}>
    <MessageScrollerViewport><MessageScrollerContent>
      <MessageScrollerItem messageId={id}>Repository opening</MessageScrollerItem>
    </MessageScrollerContent></MessageScrollerViewport>
  </MessageScrollerProvider>;
  geometryByMessageId.set("welcome", { top: 1500, height: 100 });
  await render(view("welcome"), { scrollHeight: 1700, clientHeight: 600, scrollTop: 0 });
  metrics().scrollTop = 400;
  await scroll();
  geometryByMessageId.set("home", { top: 800, height: 900 });
  await act(async () => root!.render(view("home")));
  expect(getViewport().scrollTop).toBe(400);
});
