/** @jsxImportSource react */
import { afterEach, describe, expect, test } from "bun:test";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { SMITHERS_UI_STYLE_ATTR } from "../src/index";
import {
  Message,
  MessageActions,
  MessageAvatar,
  MessageContent,
  MessageFooter,
  MessageGroup,
  MessageHeader,
} from "../src/chat/Message";
import {
  MessageBranch,
  MessageBranchContent,
  MessageBranchNext,
  MessageBranchPage,
  MessageBranchPrevious,
  MessageBranchSelector,
} from "../src/chat/MessageBranch";
import { Bubble, BubbleActions, BubbleContent, BubbleReactions } from "../src/chat/Bubble";
import { CompactGroup } from "../src/chat/CompactGroup";
import { ConversationCheckpoint } from "../src/chat/ConversationCheckpoint";
import { conversationFoundationCss } from "../src/chat/conversationFoundationCss";
import { installDarkThemeStyles, removeDarkThemeStyles } from "./theme-test-utils";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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
  document.documentElement.removeAttribute("data-theme");
  removeDarkThemeStyles();
  document.querySelectorAll(`style[${SMITHERS_UI_STYLE_ATTR}]`).forEach((element) => element.remove());
});

async function render(element: ReactElement): Promise<void> {
  const resizeObserver = globalThis.ResizeObserver;
  globalThis.ResizeObserver = undefined as unknown as typeof ResizeObserver;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const mountedRoot = root;
  try {
    await act(async () => mountedRoot.render(element));
  } finally {
    globalThis.ResizeObserver = resizeObserver;
  }
}

describe("Message", () => {
  test("renders role/alignment data attributes and layout parts", () => {
    const html = renderToStaticMarkup(
      <Message role="user">
        <MessageAvatar fallback="W" />
        <MessageContent>
          <MessageHeader>Will</MessageHeader>
          body
          <MessageFooter>sent</MessageFooter>
        </MessageContent>
      </Message>,
    );
    expect(html).toContain('data-slot="message"');
    expect(html).toContain('data-role="user"');
    expect(html).toContain('data-align="end"');
    expect(html).toContain("sui-msg-avatar");
    expect(html).toContain("sui-msg-header");
    expect(html).toContain("sui-msg-content");
    expect(html).toContain("sui-msg-footer");
  });

  test("defaults non-user roles to start alignment and marks grouped rows", () => {
    const html = renderToStaticMarkup(
      <Message role="assistant" grouped>
        <MessageContent>body</MessageContent>
      </Message>,
    );
    expect(html).toContain('data-align="start"');
    expect(html).toContain('data-grouped="true"');
  });

  test("avatar renders an img when src is given and a fallback otherwise", () => {
    const withImage = renderToStaticMarkup(<MessageAvatar src="/a.png" alt="Ada" />);
    expect(withImage).toContain("<img");
    expect(withImage).toContain('alt="Ada"');
    const decorative = renderToStaticMarkup(<MessageAvatar fallback="AI" />);
    expect(decorative).not.toContain("<img");
    expect(decorative).toContain("AI");
    expect(decorative).toContain('aria-hidden="true"');
  });

  test("avatar falls back once the image errors and retries a fresh src", async () => {
    // Loadable under happy-dom, so only the dispatched error below unmounts the img.
    const pixel = (tail: string) =>
      `data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==#${tail}`;
    const view = (src: string) => <MessageAvatar src={src} fallback="AB" />;

    await render(view(pixel("one")));
    const broken = container!.querySelector<HTMLImageElement>("img")!;
    expect(broken.getAttribute("src")).toBe(pixel("one"));
    expect(container!.textContent).toBe("");

    await act(async () => broken.dispatchEvent(new Event("error")));
    expect(container!.querySelector("img")).toBeNull();
    expect(container!.textContent).toBe("AB");

    // A different src clears the recorded failure and retries the image.
    await act(async () => root!.render(view(pixel("two"))));
    expect(container!.querySelector<HTMLImageElement>("img")?.getAttribute("src")).toBe(pixel("two"));
    expect(container!.textContent).toBe("");
  });

  test("MessageGroup carries role=group", () => {
    const html = renderToStaticMarkup(
      <MessageGroup>
        <Message role="assistant">
          <MessageContent>one</MessageContent>
        </Message>
      </MessageGroup>,
    );
    expect(html).toContain('data-slot="message-group"');
    expect(html).toContain('role="group"');
  });

  test("MessageActions is a labeled toolbar with Left/Right roving tabindex", async () => {
    await render(
      <Message role="assistant">
        <MessageContent>body</MessageContent>
        <MessageActions>
          <button type="button">copy</button>
          <button type="button">retry</button>
        </MessageActions>
      </Message>,
    );
    const toolbar = container!.querySelector<HTMLElement>('[data-slot="message-actions"]')!;
    expect(toolbar.getAttribute("role")).toBe("toolbar");
    expect(toolbar.getAttribute("aria-label")).toBe("Message actions");
    const [first, second] = Array.from(toolbar.querySelectorAll<HTMLButtonElement>("button"));
    expect(first!.tabIndex).toBe(0);
    expect(second!.tabIndex).toBe(-1);
    await act(async () => first!.focus());
    await act(async () =>
      toolbar.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true })),
    );
    expect(document.activeElement).toBe(second);
    expect(first!.tabIndex).toBe(-1);
    expect(second!.tabIndex).toBe(0);
  });

  test("MessageActions keeps exactly one tab stop as actions arrive and disable", async () => {
    const view = (actions: string[], disabled: string[] = []) => (
      <Message role="assistant">
        <MessageContent>body</MessageContent>
        <MessageActions>
          {actions.map((name) => (
            <button key={name} type="button" disabled={disabled.includes(name)}>
              {name}
            </button>
          ))}
        </MessageActions>
      </Message>
    );
    await render(view(["copy"]));
    const tabStops = () =>
      Array.from(container!.querySelectorAll<HTMLButtonElement>('[data-slot="message-actions"] button'))
        .filter((button) => button.tabIndex === 0)
        .map((button) => button.textContent);

    await act(async () => root!.render(view(["copy", "retry", "share"])));
    expect(tabStops()).toEqual(["copy"]);

    await act(async () => root!.render(view(["copy", "retry", "share"], ["copy"])));
    expect(tabStops()).toEqual(["retry"]);
  });

  test("renders under the dark theme and self-injects the lane fragment", async () => {
    installDarkThemeStyles();
    document.documentElement.dataset.theme = "dark";
    await render(
      <Message role="assistant">
        <MessageAvatar fallback="AI" />
        <MessageContent>dark</MessageContent>
      </Message>,
    );
    expect(document.querySelector(`style[${SMITHERS_UI_STYLE_ATTR}]`)?.textContent).toContain(conversationFoundationCss.trim());
    const avatar = container!.querySelector<HTMLElement>('[data-slot="message-avatar"]')!;
    expect(getComputedStyle(avatar).backgroundColor).toBe("#1a2422");
  });
});

describe("MessageBranch", () => {
  test("pages through branches with bounded prev/next and a live page label", async () => {
    const changes: number[] = [];
    await render(
      <MessageBranch count={3} onIndexChange={(index) => changes.push(index)}>
        <MessageBranchContent>branch body</MessageBranchContent>
        <MessageBranchSelector>
          <MessageBranchPrevious />
          <MessageBranchPage />
          <MessageBranchNext />
        </MessageBranchSelector>
      </MessageBranch>,
    );
    const selector = container!.querySelector<HTMLElement>('[data-slot="message-branch-selector"]')!;
    expect(selector.getAttribute("role")).toBe("group");
    expect(selector.getAttribute("aria-label")).toBe("Response branches");
    const previous = container!.querySelector<HTMLButtonElement>('[data-slot="message-branch-previous"]')!;
    const next = container!.querySelector<HTMLButtonElement>('[data-slot="message-branch-next"]')!;
    const page = container!.querySelector<HTMLElement>('[data-slot="message-branch-page"]')!;
    expect(page.textContent).toBe("1 of 3");
    expect(page.getAttribute("aria-live")).toBe("polite");
    expect(previous.disabled).toBe(true);
    expect(next.disabled).toBe(false);
    await act(async () => next.click());
    expect(changes).toEqual([1]);
    expect(page.textContent).toBe("2 of 3");
    expect(previous.disabled).toBe(false);
    await act(async () => next.click());
    await act(async () => next.click());
    expect(changes).toEqual([1, 2]);
    expect(page.textContent).toBe("3 of 3");
    expect(next.disabled).toBe(true);
  });

  test("controlled index ignores defaultIndex and round-trips requests", async () => {
    const changes: number[] = [];
    const view = (index: number) => (
      <MessageBranch count={2} index={index} defaultIndex={0} onIndexChange={(i) => changes.push(i)}>
        <MessageBranchPage />
        <MessageBranchNext />
      </MessageBranch>
    );
    await render(view(0));
    const next = container!.querySelector<HTMLButtonElement>('[data-slot="message-branch-next"]')!;
    await act(async () => next.click());
    expect(changes).toEqual([1]);
    expect(container!.querySelector('[data-slot="message-branch-page"]')!.textContent).toBe("1 of 2");
    await act(async () => root!.render(view(1)));
    expect(container!.querySelector('[data-slot="message-branch-page"]')!.textContent).toBe("2 of 2");
  });

  test("branch content swaps the rendered branch while keeping state mounted", async () => {
    await render(
      <MessageBranch count={2}>
        <MessageBranchContent>
          <div>first response</div>
          <div>second response</div>
        </MessageBranchContent>
        <MessageBranchSelector>
          <MessageBranchPrevious />
          <MessageBranchNext />
        </MessageBranchSelector>
      </MessageBranch>,
    );
    const panels = () => Array.from(container!.querySelectorAll<HTMLElement>('[data-slot="message-branch-content"]'));
    expect(panels()).toHaveLength(2);
    expect(panels()[0]!.hidden).toBe(false);
    expect(panels()[0]!.textContent).toBe("first response");
    expect(panels()[1]!.hidden).toBe(true);
    expect(panels()[1]!.getAttribute("aria-hidden")).toBe("true");
    await act(async () => container!.querySelector<HTMLButtonElement>('[data-slot="message-branch-next"]')!.click());
    expect(panels()[0]!.hidden).toBe(true);
    expect(panels()[1]!.hidden).toBe(false);
    await act(async () =>
      container!.querySelector<HTMLButtonElement>('[data-slot="message-branch-previous"]')!.click(),
    );
    expect(panels()[0]!.hidden).toBe(false);
    expect(panels()[1]!.hidden).toBe(true);
  });

  test("uncontrolled index is reconciled when the branch count shrinks", async () => {
    const changes: number[] = [];
    const view = (count: number) => (
      <MessageBranch count={count} defaultIndex={2} onIndexChange={(index) => changes.push(index)}>
        <MessageBranchContent>
          <div>first</div>
          <div>second</div>
          <div>third</div>
        </MessageBranchContent>
        <MessageBranchPage />
        <MessageBranchNext />
      </MessageBranch>
    );
    await render(view(3));
    const page = () => container!.querySelector('[data-slot="message-branch-page"]')!;
    const branch = () => container!.querySelector('[data-slot="message-branch"]')!;
    expect(page().textContent).toBe("3 of 3");
    await act(async () => root!.render(view(1)));
    expect(page().textContent).toBe("1 of 1");
    expect(branch().getAttribute("data-branch-index")).toBe("0");
    const panels = Array.from(container!.querySelectorAll<HTMLElement>('[data-slot="message-branch-content"]'));
    expect(panels[0]!.hidden).toBe(false);
    // Reconciliation is silent: a count-driven clamp is not a user navigation.
    expect(changes).toEqual([]);
    // The reconciled state sticks when the count grows back.
    await act(async () => root!.render(view(3)));
    expect(page().textContent).toBe("1 of 3");
  });

  test("uses accessible button labels", () => {
    const html = renderToStaticMarkup(
      <MessageBranch count={2}>
        <MessageBranchPrevious />
        <MessageBranchNext />
      </MessageBranch>,
    );
    expect(html).toContain('aria-label="Previous response"');
    expect(html).toContain('aria-label="Next response"');
  });

  test("a zero branch count renders no active branch instead of invalid state", async () => {
    await render(
      <MessageBranch count={0}>
        <MessageBranchContent>
          <div>first</div>
        </MessageBranchContent>
        <MessageBranchPrevious />
        <MessageBranchPage />
        <MessageBranchNext />
      </MessageBranch>,
    );
    const branch = container!.querySelector('[data-slot="message-branch"]')!;
    expect(branch.getAttribute("data-branch-count")).toBe("0");
    expect(branch.getAttribute("data-branch-index")).toBe("-1");
    expect(container!.querySelector('[data-slot="message-branch-page"]')!.textContent).toBe("0 of 0");
    const panels = container!.querySelectorAll<HTMLElement>('[data-slot="message-branch-content"]');
    for (const panel of panels) expect(panel.hidden).toBe(true);
    expect(container!.querySelector<HTMLButtonElement>('[data-slot="message-branch-previous"]')!.disabled).toBe(true);
    expect(container!.querySelector<HTMLButtonElement>('[data-slot="message-branch-next"]')!.disabled).toBe(true);
  });

  test("a transient zero count hides branches but preserves the uncontrolled index", async () => {
    const view = (count: number) => (
      <MessageBranch count={count} defaultIndex={1}>
        <MessageBranchContent>
          <div>first</div>
          <div>second</div>
        </MessageBranchContent>
        <MessageBranchPage />
      </MessageBranch>
    );
    await render(view(2));
    const page = () => container!.querySelector('[data-slot="message-branch-page"]')!;
    expect(page().textContent).toBe("2 of 2");
    await act(async () => root!.render(view(0)));
    expect(page().textContent).toBe("0 of 0");
    const panels = container!.querySelectorAll<HTMLElement>('[data-slot="message-branch-content"]');
    for (const panel of panels) expect(panel.hidden).toBe(true);
    // The empty state is transient: the user's branch survives it.
    await act(async () => root!.render(view(2)));
    expect(page().textContent).toBe("2 of 2");
  });
});

describe("Bubble compound", () => {
  test("composed mode renders children verbatim with the clamp on BubbleContent", async () => {
    await render(
      <Bubble variant="assistant" composed collapsible>
        <BubbleContent>composed body</BubbleContent>
        <BubbleActions>
          <button type="button">copy</button>
        </BubbleActions>
      </Bubble>,
    );
    const bubble = container!.querySelector<HTMLElement>('[data-slot="bubble"]')!;
    const content = container!.querySelector<HTMLElement>('[data-slot="bubble-content"]')!;
    expect(bubble.firstElementChild).toBe(content);
    expect(content.id).not.toBe("");
    const actions = container!.querySelector<HTMLElement>('[data-slot="bubble-actions"]')!;
    expect(actions.getAttribute("role")).toBe("toolbar");
    const toggle = container!.querySelector<HTMLButtonElement>('[data-slot="bubble-toggle"]')!;
    expect(toggle.getAttribute("aria-controls")).toBe(content.id);
  });

  test("BubbleReactions render pressed state and report toggles by key", async () => {
    const toggled: string[] = [];
    await render(
      <Bubble composed>
        <BubbleContent>body</BubbleContent>
        <BubbleReactions
          reactions={[
            { key: "up", label: "👍", count: 2, pressed: true },
            { key: "down", label: "👎" },
          ]}
          onToggle={(key) => toggled.push(key)}
        />
      </Bubble>,
    );
    const buttons = container!.querySelectorAll<HTMLButtonElement>('[data-slot="bubble-reaction"]');
    expect(buttons).toHaveLength(2);
    expect(buttons[0]!.getAttribute("aria-pressed")).toBe("true");
    expect(buttons[1]!.getAttribute("aria-pressed")).toBe("false");
    await act(async () => buttons[1]!.click());
    expect(toggled).toEqual(["down"]);
  });

  test("legacy children path keeps the exact existing DOM", () => {
    const html = renderToStaticMarkup(<Bubble variant="user">legacy</Bubble>);
    expect(html).toBe(
      '<div data-slot="bubble" data-variant="user" data-align="end" class="sui-bubble sui-bubble-user"><div data-slot="bubble-content" id="«r0»" class="sui-bubble-content">legacy</div></div>'.replace(
        "«r0»",
        html.match(/id="([^"]+)"/)![1]!,
      ),
    );
  });
});

describe("CompactGroup", () => {
  test("defaults closed with the count label and opens via the disclosure", async () => {
    await render(
      <CompactGroup count={3}>
        <div>older turn</div>
      </CompactGroup>,
    );
    const root = container!.querySelector<HTMLElement>('[data-slot="compact-group"]')!;
    const trigger = container!.querySelector<HTMLButtonElement>('[data-slot="compact-group-trigger"]')!;
    expect(root.getAttribute("data-open")).toBe("false");
    expect(trigger.textContent).toContain("3 earlier messages");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(container!.querySelector('[data-slot="compact-group-content"]')).toBeNull();
    await act(async () => trigger.click());
    const content = container!.querySelector<HTMLElement>('[data-slot="compact-group-content"]')!;
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(content.getAttribute("role")).toBe("region");
    expect(content.id).toBe(trigger.getAttribute("aria-controls"));
    expect(content.textContent).toContain("older turn");
  });

  test("controlled open round-trips without self-managing", async () => {
    const changes: boolean[] = [];
    const view = (open: boolean) => (
      <CompactGroup count={2} open={open} onOpenChange={(next) => changes.push(next)}>
        <div>turn</div>
      </CompactGroup>
    );
    await render(view(false));
    const trigger = container!.querySelector<HTMLButtonElement>('[data-slot="compact-group-trigger"]')!;
    await act(async () => trigger.click());
    expect(changes).toEqual([true]);
    expect(container!.querySelector('[data-slot="compact-group-content"]')).toBeNull();
    await act(async () => root!.render(view(true)));
    expect(container!.querySelector('[data-slot="compact-group-content"]')).not.toBeNull();
  });
});

describe("ConversationCheckpoint", () => {
  test("renders label, optional time, and actions without role=separator", () => {
    const html = renderToStaticMarkup(
      <ConversationCheckpoint
        label="Checkpoint 12"
        timestampMs={1_700_000_000_000}
        actions={<button>restore</button>}
      />,
    );
    expect(html).toContain('data-slot="conversation-checkpoint"');
    expect(html).toContain("Checkpoint 12");
    expect(html).toContain("<time");
    expect(html).toContain("restore");
    expect(html).not.toContain('role="separator"');
  });

  test("omits the time element when no timestamp is given", () => {
    const html = renderToStaticMarkup(<ConversationCheckpoint label="saved" />);
    expect(html).not.toContain("<time");
  });
});
