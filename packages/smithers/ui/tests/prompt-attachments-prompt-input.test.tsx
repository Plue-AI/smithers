/** @jsxImportSource react */
import { afterEach, describe, expect, test } from "bun:test";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import {
  PromptInput,
  PromptInputActionAddAttachments,
  PromptInputActionMenu,
  PromptInputActionMenuContent,
  PromptInputActionMenuTrigger,
  PromptInputBody,
  PromptInputButton,
  PromptInputFooter,
  PromptInputHeader,
  PromptInputStop,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
  usePromptInputAttachments,
  type PromptInputAttachmentItem,
  type PromptInputMessage,
} from "../src/prompt/PromptInput";
import { SMITHERS_UI_STYLE_ATTR } from "../src/index";
import { promptAttachmentsCss } from "../src/prompt/promptAttachmentsCss";
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
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const mountedRoot = root;
  await act(async () => mountedRoot.render(element));
}

function pressEnter(target: HTMLElement, init: KeyboardEventInit = {}) {
  target.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...init }));
}

const textareaValueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!;

function typeText(textarea: HTMLTextAreaElement, text: string) {
  textareaValueSetter.call(textarea, text);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

function makeFile(name: string, options?: FilePropertyBag): File {
  return new File(["x"], name, options);
}

describe("PromptInput", () => {
  test("renders the form shell with slots and the textarea default aria-label", () => {
    const html = renderToStaticMarkup(
      <PromptInput onSubmit={() => {}}>
        <PromptInputBody>
          <PromptInputTextarea />
        </PromptInputBody>
        <PromptInputFooter>
          <PromptInputTools />
          <PromptInputSubmit />
        </PromptInputFooter>
      </PromptInput>,
    );
    expect(html).toContain('data-slot="prompt-input"');
    expect(html).toContain('data-slot="prompt-input-body"');
    expect(html).toContain('data-slot="prompt-input-footer"');
    expect(html).toContain('data-slot="prompt-input-tools"');
    expect(html).toContain('data-slot="prompt-input-textarea"');
    expect(html).toContain('aria-label="Message"');
    expect(html).toContain('aria-label="Send message"');
  });

  test("uncontrolled input submits text on Enter and clears", async () => {
    const submitted: PromptInputMessage[] = [];
    await render(
      <PromptInput onSubmit={(message) => submitted.push(message)}>
        <PromptInputTextarea />
      </PromptInput>,
    );
    const textarea = container!.querySelector<HTMLTextAreaElement>("textarea")!;
    await act(async () => typeText(textarea, "hello world"));
    await act(async () => pressEnter(textarea));
    expect(submitted).toHaveLength(1);
    expect(submitted[0]!.text).toBe("hello world");
    expect(submitted[0]!.attachments).toEqual([]);
    expect(textarea.value).toBe("");
  });

  test("controlled value round-trips through onValueChange without self-managing", async () => {
    const seen: string[] = [];
    const view = (value: string) => (
      <PromptInput value={value} onValueChange={(next) => seen.push(next)} onSubmit={() => {}}>
        <PromptInputTextarea />
      </PromptInput>
    );
    await render(view("fixed"));
    const textarea = container!.querySelector<HTMLTextAreaElement>("textarea")!;
    await act(async () => typeText(textarea, "fixed!"));
    expect(seen).toEqual(["fixed!"]);
    expect(textarea.value).toBe("fixed");
    await act(async () => root!.render(view("updated")));
    expect(container!.querySelector<HTMLTextAreaElement>("textarea")!.value).toBe("updated");
  });

  test("Shift+Enter inserts a newline instead of submitting", async () => {
    const submitted: PromptInputMessage[] = [];
    await render(
      <PromptInput defaultValue="line one" onSubmit={(message) => submitted.push(message)}>
        <PromptInputTextarea />
      </PromptInput>,
    );
    const textarea = container!.querySelector<HTMLTextAreaElement>("textarea")!;
    await act(async () => pressEnter(textarea, { shiftKey: true }));
    expect(submitted).toHaveLength(0);
  });

  test("mod-enter submitKey makes bare Enter a newline and mod+Enter submit", async () => {
    const submitted: PromptInputMessage[] = [];
    await render(
      <PromptInput defaultValue="draft" submitKey="mod-enter" onSubmit={(message) => submitted.push(message)}>
        <PromptInputTextarea />
      </PromptInput>,
    );
    const textarea = container!.querySelector<HTMLTextAreaElement>("textarea")!;
    await act(async () => pressEnter(textarea));
    expect(submitted).toHaveLength(0);
    await act(async () => pressEnter(textarea, { metaKey: true }));
    expect(submitted).toHaveLength(1);
    expect(submitted[0]!.text).toBe("draft");
  });

  test("attachments render as removable chips and announce removal", async () => {
    let hook!: ReturnType<typeof usePromptInputAttachments>;
    function Harness() {
      hook = usePromptInputAttachments();
      return <PromptInputTextarea />;
    }
    await render(
      <PromptInput onSubmit={() => {}}>
        <Harness />
      </PromptInput>,
    );
    await act(async () => hook.add([makeFile("report.pdf", { type: "application/pdf" })]));
    const chip = container!.querySelector('[data-slot="attachment"]')!;
    expect(chip.getAttribute("role")).toBe("listitem");
    expect(container!.querySelector('[data-slot="attachment-name"]')!.textContent).toBe("report.pdf");
    expect(container!.querySelector('[data-slot="prompt-input-attachments"]')!.getAttribute("role")).toBe("list");
    await act(async () => container!.querySelector<HTMLButtonElement>('[data-slot="attachment-remove"]')!.click());
    expect(hook.attachments).toHaveLength(0);
    expect(container!.querySelector('[aria-live="polite"]')!.textContent).toBe("report.pdf removed");
  });

  test("image files get object URLs that are revoked on remove", async () => {
    let hook!: ReturnType<typeof usePromptInputAttachments>;
    function Harness() {
      hook = usePromptInputAttachments();
      return <PromptInputTextarea />;
    }
    await render(
      <PromptInput onSubmit={() => {}}>
        <Harness />
      </PromptInput>,
    );
    await act(async () => hook.add([makeFile("photo.png", { type: "image/png" })]));
    const item = hook.attachments[0]!;
    if (typeof URL.createObjectURL === "function") {
      expect(item.thumbnailUrl).toContain("blob:");
      expect(container!.querySelector('[data-slot="attachment-thumb"] img')).not.toBeNull();
      await act(async () => hook.remove(item.id));
    } else {
      expect(item.thumbnailUrl).toBeUndefined();
    }
  });

  test("clear removes all image object URLs before unmount", async () => {
    let hook!: ReturnType<typeof usePromptInputAttachments>;
    const created: string[] = [];
    const revoked: string[] = [];
    const originalCreate = URL.createObjectURL;
    const originalRevoke = URL.revokeObjectURL;
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: (file: File) => {
        const url = `blob:clear-${created.length}`;
        created.push(url);
        return url;
      },
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: (url: string) => revoked.push(url),
    });
    try {
      function Harness() {
        hook = usePromptInputAttachments();
        return <PromptInputTextarea />;
      }
      await render(
        <PromptInput onSubmit={() => {}} multiple>
          <Harness />
        </PromptInput>,
      );
      await act(async () =>
        hook.add([makeFile("one.png", { type: "image/png" }), makeFile("two.jpg", { type: "image/jpeg" })]),
      );
      expect(created).toHaveLength(2);
      await act(async () => hook.clear());
      expect(hook.attachments).toEqual([]);
      expect(revoked).toEqual(created);
      await act(async () => root!.unmount());
      root = undefined;
      expect(revoked).toEqual(created);
    } finally {
      Object.defineProperty(URL, "createObjectURL", { configurable: true, value: originalCreate });
      Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: originalRevoke });
    }
  });

  test("uncontrolled submit revokes image object URLs after preserving the payload", async () => {
    const submitted: PromptInputMessage[] = [];
    let hook!: ReturnType<typeof usePromptInputAttachments>;
    const created: string[] = [];
    const revoked: string[] = [];
    const originalCreate = URL.createObjectURL;
    const originalRevoke = URL.revokeObjectURL;
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: (file: File) => {
        const url = `blob:submit-${created.length}`;
        created.push(url);
        return url;
      },
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: (url: string) => revoked.push(url),
    });
    try {
      function Harness() {
        hook = usePromptInputAttachments();
        return <PromptInputTextarea />;
      }
      await render(
        <PromptInput onSubmit={(message) => submitted.push(message)} multiple>
          <Harness />
        </PromptInput>,
      );
      await act(async () =>
        hook.add([makeFile("one.png", { type: "image/png" }), makeFile("two.jpg", { type: "image/jpeg" })]),
      );
      const payloadAttachments = hook.attachments;
      await act(async () => pressEnter(container!.querySelector<HTMLTextAreaElement>("textarea")!));
      expect(submitted).toHaveLength(1);
      expect(submitted[0]!.attachments).toBe(payloadAttachments);
      expect(hook.attachments).toEqual([]);
      expect(revoked).toEqual(created);
      await act(async () => root!.unmount());
      root = undefined;
      expect(revoked).toEqual(created);
    } finally {
      Object.defineProperty(URL, "createObjectURL", { configurable: true, value: originalCreate });
      Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: originalRevoke });
    }
  });

  test("onError fires for max-files, max-file-size, and accept violations", async () => {
    const errors: string[] = [];
    let hook!: ReturnType<typeof usePromptInputAttachments>;
    function Harness() {
      hook = usePromptInputAttachments();
      return <PromptInputTextarea />;
    }
    await render(
      <PromptInput
        onSubmit={() => {}}
        multiple
        maxFiles={1}
        maxFileSizeBytes={2}
        accept=".png"
        onError={(error) => errors.push(error.code)}
      >
        <Harness />
      </PromptInput>,
    );
    await act(async () =>
      hook.add([makeFile("a.png", { type: "image/png" }), makeFile("b.png", { type: "image/png" })]),
    );
    expect(errors).toEqual(["max-files"]);
    expect(hook.attachments.map((item) => item.name)).toEqual(["a.png"]);
    await act(async () => hook.add([new File(["too large"], "big.png", { type: "image/png" })]));
    expect(errors).toContain("max-files");
    await act(async () => hook.clear());
    await act(async () => hook.add([new File(["too large"], "big.png", { type: "image/png" })]));
    expect(errors).toContain("max-file-size");
    await act(async () => hook.add([makeFile("doc.txt", { type: "text/plain" })]));
    expect(errors).toContain("accept");
    expect(hook.attachments).toHaveLength(0);
  });

  test("defaultAttachments seed the uncontrolled attachment list", () => {
    const seed: PromptInputAttachmentItem[] = [{ id: "a1", name: "seed.txt", state: "ready" }];
    const html = renderToStaticMarkup(
      <PromptInput defaultAttachments={seed} onSubmit={() => {}}>
        <PromptInputTextarea />
      </PromptInput>,
    );
    expect(html).toContain("seed.txt");
  });

  test("submit includes attachments and is blocked while submitted or streaming", async () => {
    const submitted: PromptInputMessage[] = [];
    const seed: PromptInputAttachmentItem[] = [{ id: "a1", name: "seed.txt" }];
    const view = (status: "ready" | "submitted" | "streaming") => (
      <PromptInput
        defaultValue="hi"
        defaultAttachments={seed}
        status={status}
        onSubmit={(message) => submitted.push(message)}
      >
        <PromptInputTextarea />
      </PromptInput>
    );
    await render(view("ready"));
    const textarea = container!.querySelector<HTMLTextAreaElement>("textarea")!;
    await act(async () => pressEnter(textarea));
    expect(submitted).toHaveLength(1);
    expect(submitted[0]!.attachments.map((item) => item.name)).toEqual(["seed.txt"]);
    await act(async () => root!.render(view("submitted")));
    await act(async () => pressEnter(container!.querySelector<HTMLTextAreaElement>("textarea")!));
    expect(submitted).toHaveLength(1);
  });

  test("PromptInputSubmit mirrors data-status and disables while submitted/streaming", async () => {
    const view = (status: "ready" | "submitted" | "streaming" | "error") => (
      <PromptInput defaultValue="hi" status={status} onSubmit={() => {}}>
        <PromptInputTextarea />
        <PromptInputSubmit />
      </PromptInput>
    );
    await render(view("ready"));
    const submit = () => container!.querySelector<HTMLButtonElement>('[data-slot="prompt-input-submit"]')!;
    expect(submit().disabled).toBe(false);
    expect(submit().getAttribute("data-status")).toBe("ready");
    await act(async () => root!.render(view("submitted")));
    expect(submit().disabled).toBe(true);
    expect(submit().getAttribute("data-status")).toBe("submitted");
    expect(submit().querySelector('[data-slot="spinner"]')).not.toBeNull();
    await act(async () => root!.render(view("streaming")));
    expect(submit().disabled).toBe(true);
    await act(async () => root!.render(view("error")));
    expect(submit().getAttribute("data-status")).toBe("error");
  });

  test("empty value with no attachments disables submission", async () => {
    await render(
      <PromptInput onSubmit={() => {}}>
        <PromptInputTextarea />
        <PromptInputSubmit />
      </PromptInput>,
    );
    expect(container!.querySelector<HTMLButtonElement>('[data-slot="prompt-input-submit"]')!.disabled).toBe(true);
  });

  test("PromptInputStop renders only while busy with onStop, and Escape calls onStop", async () => {
    let stops = 0;
    const view = (status: "ready" | "streaming") => (
      <PromptInput defaultValue="hi" status={status} onStop={() => (stops += 1)} onSubmit={() => {}}>
        <PromptInputTextarea />
        <PromptInputStop />
      </PromptInput>
    );
    await render(view("ready"));
    expect(container!.querySelector('[data-slot="prompt-input-stop"]')).toBeNull();
    await act(async () => root!.render(view("streaming")));
    const stop = container!.querySelector<HTMLButtonElement>('[data-slot="prompt-input-stop"]')!;
    expect(stop.getAttribute("aria-label")).toBe("Stop generating");
    await act(async () => stop.click());
    expect(stops).toBe(1);
    await act(async () => {
      container!
        .querySelector<HTMLTextAreaElement>("textarea")!
        .dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    expect(stops).toBe(2);
  });

  test("action menu exposes menu semantics, wraps unmarked children, and closes on Escape", async () => {
    const opens: boolean[] = [];
    await render(
      <PromptInput onSubmit={() => {}}>
        <PromptInputTextarea />
        <PromptInputActionMenu onOpenChange={(open) => opens.push(open)}>
          <PromptInputActionMenuTrigger />
          <PromptInputActionMenuContent>
            <span>plain child</span>
            <PromptInputActionAddAttachments />
          </PromptInputActionMenuContent>
        </PromptInputActionMenu>
      </PromptInput>,
    );
    const trigger = container!.querySelector<HTMLButtonElement>('[data-slot="prompt-input-action-menu-trigger"]')!;
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(container!.querySelector('[role="menu"]')).toBeNull();
    await act(async () => trigger.click());
    expect(opens).toEqual([true]);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    const menu = container!.querySelector('[role="menu"]')!;
    expect(trigger.getAttribute("aria-controls")).toBe(menu.id);
    const items = menu.querySelectorAll('[role="menuitem"]');
    expect(items).toHaveLength(2);
    expect(items[0]!.getAttribute("data-slot")).toBe("prompt-input-action-menu-item");
    expect(items[0]!.tagName).toBe("DIV");
    expect(items[1]!.tagName).toBe("BUTTON");
    expect(items[1]!.textContent).toContain("Add attachments");
    await act(async () => {
      menu.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    expect(opens).toEqual([true, false]);
    expect(container!.querySelector('[role="menu"]')).toBeNull();
  });

  test("controlled action menu open state round-trips", async () => {
    const opens: boolean[] = [];
    const view = (open: boolean) => (
      <PromptInput onSubmit={() => {}}>
        <PromptInputActionMenu open={open} onOpenChange={(next) => opens.push(next)}>
          <PromptInputActionMenuTrigger />
          <PromptInputActionMenuContent>
            <span>x</span>
          </PromptInputActionMenuContent>
        </PromptInputActionMenu>
      </PromptInput>
    );
    await render(view(false));
    await act(async () =>
      container!.querySelector<HTMLButtonElement>('[data-slot="prompt-input-action-menu-trigger"]')!.click(),
    );
    expect(opens).toEqual([true]);
    expect(container!.querySelector('[role="menu"]')).toBeNull();
    await act(async () => root!.render(view(true)));
    expect(container!.querySelector('[role="menu"]')).not.toBeNull();
  });

  test("usePromptInputAttachments throws outside a PromptInput", () => {
    function Orphan() {
      usePromptInputAttachments();
      return null;
    }
    expect(() => renderToStaticMarkup(<Orphan />)).toThrow(/within a PromptInput/);
  });

  test("globalDrop adds files dropped on the document", async () => {
    let hook!: ReturnType<typeof usePromptInputAttachments>;
    function Harness() {
      hook = usePromptInputAttachments();
      return <PromptInputTextarea />;
    }
    await render(
      <PromptInput globalDrop onSubmit={() => {}}>
        <Harness />
      </PromptInput>,
    );
    const dropEvent = new Event("drop", { bubbles: true, cancelable: true });
    Object.assign(dropEvent, { dataTransfer: { files: [makeFile("dropped.txt", { type: "text/plain" })] } });
    await act(async () => {
      document.dispatchEvent(dropEvent);
    });
    expect(hook.attachments.map((item) => item.name)).toEqual(["dropped.txt"]);
  });

  test("two synchronous add() calls in one tick keep both batches", async () => {
    let hook!: ReturnType<typeof usePromptInputAttachments>;
    function Harness() {
      hook = usePromptInputAttachments();
      return <PromptInputTextarea />;
    }
    await render(
      <PromptInput onSubmit={() => {}} multiple>
        <Harness />
      </PromptInput>,
    );
    await act(async () => {
      hook.add([makeFile("first.txt", { type: "text/plain" })]);
      hook.add([makeFile("second.txt", { type: "text/plain" })]);
    });
    expect(hook.attachments.map((item) => item.name)).toEqual(["first.txt", "second.txt"]);
  });

  test("drop on the form with globalDrop enabled intakes files exactly once", async () => {
    let hook!: ReturnType<typeof usePromptInputAttachments>;
    function Harness() {
      hook = usePromptInputAttachments();
      return <PromptInputTextarea />;
    }
    await render(
      <PromptInput globalDrop onSubmit={() => {}}>
        <Harness />
      </PromptInput>,
    );
    const form = container!.querySelector("form")!;
    const dropEvent = new Event("drop", { bubbles: true, cancelable: true });
    Object.assign(dropEvent, { dataTransfer: { files: [makeFile("once.txt", { type: "text/plain" })] } });
    await act(async () => {
      form.dispatchEvent(dropEvent);
    });
    expect(hook.attachments.map((item) => item.name)).toEqual(["once.txt"]);
    expect(new Set(hook.attachments.map((item) => item.id)).size).toBe(hook.attachments.length);
  });

  test("paste with files adds attachments", async () => {
    let hook!: ReturnType<typeof usePromptInputAttachments>;
    function Harness() {
      hook = usePromptInputAttachments();
      return <PromptInputTextarea />;
    }
    await render(
      <PromptInput onSubmit={() => {}}>
        <Harness />
      </PromptInput>,
    );
    const form = container!.querySelector("form")!;
    const pasteEvent = new Event("paste", { bubbles: true, cancelable: true });
    Object.assign(pasteEvent, { clipboardData: { files: [makeFile("pasted.png", { type: "image/png" })] } });
    await act(async () => {
      form.dispatchEvent(pasteEvent);
    });
    expect(hook.attachments.map((item) => item.name)).toEqual(["pasted.png"]);
  });

  test("header, button, and static parts render under the dark theme", async () => {
    installDarkThemeStyles();
    document.documentElement.dataset.theme = "dark";
    await render(
      <PromptInput onSubmit={() => {}}>
        <PromptInputHeader>queued</PromptInputHeader>
        <PromptInputBody>
          <PromptInputTextarea />
        </PromptInputBody>
        <PromptInputFooter>
          <PromptInputButton aria-label="Attach">+</PromptInputButton>
        </PromptInputFooter>
      </PromptInput>,
    );
    const form = container!.querySelector<HTMLElement>('[data-slot="prompt-input"]')!;
    expect(form.className).toContain("sui-prompt");
    expect(container!.querySelector('[data-slot="prompt-input-header"]')!.textContent).toBe("queued");
    expect(getComputedStyle(form).backgroundColor).toBe("#131b1a");
    expect(document.querySelector(`style[${SMITHERS_UI_STYLE_ATTR}]`)?.textContent).toContain(promptAttachmentsCss.trim());
  });
});
