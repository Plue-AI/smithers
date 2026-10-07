/** @jsxImportSource react */
import { copyText } from "../src/index";
import { afterEach, describe, expect, test, jest } from "bun:test";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SecretField } from "../src/artifacts/SecretField";
import { Snippet } from "../src/artifacts/Snippet";
import { CodeBlock } from "../src/primitives/CodeBlock";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean; }).IS_REACT_ACT_ENVIRONMENT = true;

type CopyError = { code: "clipboard-unavailable" | "clipboard-write-failed"; cause: unknown; };
type AffordanceProps = {
  onCopy?: (value: string) => void | Promise<void>;
  onCopyError?: (error: CopyError) => void;
};
type Affordance = {
  name: string;
  value: string;
  rootSelector: string;
  buttonSelector: string;
  element: (props: AffordanceProps) => ReactElement;
};

const affordances: readonly Affordance[] = [
  {
    name: "CodeBlock",
    value: "const answer = 42",
    rootSelector: '[data-slot="code-block"]',
    buttonSelector: '[data-slot="code-block-copy"]',
    element: ({ onCopy, onCopyError }) => (
      <CodeBlock code="const answer = 42" onCopyCode={onCopy} onCopyError={onCopyError} />
    ),
  },
  {
    name: "Snippet",
    value: "pnpm test",
    rootSelector: '[data-slot="snippet"]',
    buttonSelector: '[data-slot="snippet-copy"]',
    element: ({ onCopy, onCopyError }) => <Snippet code="pnpm test" onCopyCode={onCopy} onCopyError={onCopyError} />,
  },
  {
    name: "SecretField",
    value: "secret-value",
    rootSelector: '[data-slot="secret-field"]',
    buttonSelector: '[data-slot="secret-field-copy"]',
    element: ({ onCopy, onCopyError }) => (
      <SecretField
        value="secret-value"
        onCopy={onCopy}
        onCopyError={onCopyError}
      />
    ),
  },
];

const originalClipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
let container: HTMLElement | undefined;
let root: Root | undefined;

afterEach(async () => {
  if (root) {
    const current = root;
    await act(async () => current.unmount());
    root = undefined;
  }
  container?.remove();
  container = undefined;
  if (originalClipboardDescriptor) {
    Object.defineProperty(navigator, "clipboard", originalClipboardDescriptor);
  } else {
    delete (navigator as Navigator & { clipboard?: Clipboard; }).clipboard;
  }
});

async function render(element: ReactElement): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const current = root;
  await act(async () => current.render(element));
}

function setClipboard(writeText: (value: string) => Promise<void>): void {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
}

function deferred(): { promise: Promise<void>; resolve: () => void; } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

for (const affordance of affordances) {
  describe(`${affordance.name} copy result`, () => {
    test("reports a rejecting clipboard without claiming success", async () => {
      const cause = new Error("host clipboard detail");
      const errors: CopyError[] = [];
      setClipboard(async () => {
        throw cause;
      });
      await render(affordance.element({ onCopyError: (error) => errors.push(error) }));

      const button = container!.querySelector<HTMLButtonElement>(affordance.buttonSelector)!;
      await act(async () => {
        button.click();
        await Promise.resolve();
      });

      expect(button.textContent).toBe("Copy");
      expect(container!.querySelector(affordance.rootSelector)!.getAttribute("data-copy-failed")).toBe("true");
      expect(errors).toEqual([{ code: "clipboard-unavailable", cause }]);
      expect(container!.textContent).not.toContain(cause.message);
    });

    test("reports a synchronously throwing copy callback", async () => {
      const cause = new Error("callback detail");
      const errors: CopyError[] = [];
      await render(
        affordance.element({
          onCopy: () => {
            throw cause;
          },
          onCopyError: (error) => errors.push(error),
        }),
      );

      const button = container!.querySelector<HTMLButtonElement>(affordance.buttonSelector)!;
      await act(async () => {
        button.click();
        await Promise.resolve();
      });

      expect(button.textContent).toBe("Copy");
      expect(container!.querySelector(affordance.rootSelector)!.getAttribute("data-copy-failed")).toBe("true");
      expect(errors).toEqual([{ code: "clipboard-unavailable", cause }]);
    });

    test("claims success only after an async callback resolves", async () => {
      const pending = deferred();
      await render(affordance.element({ onCopy: () => pending.promise }));
      const button = container!.querySelector<HTMLButtonElement>(affordance.buttonSelector)!;

      await act(async () => {
        button.click();
        await Promise.resolve();
      });
      expect(button.textContent).toBe("Copy");

      await act(async () => {
        pending.resolve();
        await pending.promise;
        await Promise.resolve();
      });
      expect(button.textContent).toBe("Copied");
      expect(container!.querySelector(affordance.rootSelector)!.hasAttribute("data-copy-failed")).toBe(false);
    });

    test("ignores a second click while a write is in flight", async () => {
      const pending = deferred();
      let writes = 0;
      setClipboard(() => {
        writes += 1;
        return pending.promise;
      });
      await render(affordance.element({}));
      const button = container!.querySelector<HTMLButtonElement>(affordance.buttonSelector)!;

      await act(async () => {
        button.click();
        button.click();
        await Promise.resolve();
      });
      expect(writes).toBe(1);

      await act(async () => {
        pending.resolve();
        await pending.promise;
        await Promise.resolve();
      });
    });

    test("settles safely after unmounting mid-flight", async () => {
      const pending = deferred();
      const consoleErrors: unknown[][] = [];
      const originalConsoleError = console.error;
      console.error = (...args: unknown[]) => {
        consoleErrors.push(args);
      };
      try {
        await render(affordance.element({ onCopy: () => pending.promise }));
        const button = container!.querySelector<HTMLButtonElement>(affordance.buttonSelector)!;
        await act(async () => {
          button.click();
          await Promise.resolve();
        });
        const current = root!;
        await act(async () => current.unmount());
        root = undefined;

        await act(async () => {
          pending.resolve();
          await pending.promise;
          await Promise.resolve();
        });
        expect(consoleErrors).toEqual([]);
      } finally {
        console.error = originalConsoleError;
      }
    });
  });
}

for (const affordance of affordances) {
  test(`${affordance.name} clears Copied when a later copy fails`, async () => {
    let fail = false;
    const errors: CopyError[] = [];
    await render(
      affordance.element({
        onCopy: () => {
          if (fail) throw new Error("second copy");
        },
        onCopyError: (error) => errors.push(error),
      }),
    );
    const button = container!.querySelector<HTMLButtonElement>(affordance.buttonSelector)!;
    await act(async () => {
      button.click();
      await Promise.resolve();
    });
    expect(button.textContent).toBe("Copied");

    fail = true;
    await act(async () => {
      button.click();
      await Promise.resolve();
    });
    expect(button.textContent).toBe("Copy");
    expect(container!.querySelector(affordance.rootSelector)!.getAttribute("data-copy-failed")).toBe("true");
    expect(errors).toHaveLength(1);
  });
}

test("CodeBlock resets Copied after copiedDurationMs", async () => {
 jest.useFakeTimers();
 try {
  await render(<CodeBlock code="x" onCopyCode={() => {}} copiedDurationMs={20} />);
  const button = container!.querySelector<HTMLButtonElement>('[data-slot="code-block-copy"]')!;
  await act(async () => { button.click(); await Promise.resolve(); });
  expect(button.textContent).toBe("Copied");
  await act(async () => { jest.advanceTimersByTime(20); });
  expect(button.textContent).toBe("Copy");
 } finally { jest.useRealTimers(); }
});

test("public copyText falls back after a refused host write and preserves focus", async () => {
 const original = Object.getOwnPropertyDescriptor(document, "execCommand");
 const focus = document.createElement("input"); document.body.append(focus); focus.focus();
 let copies = 0;
 Object.defineProperty(document, "execCommand", {configurable:true, value:(command:string)=>{
  expect(command).toBe("copy");
  expect((document.activeElement as HTMLTextAreaElement).value).toBe("plain HTTP copy");
  copies++; return true;
 }});
 try {
  const pending = deferred();
  let finished = false;
  const result = copyText("plain HTTP copy", async () => { await pending.promise; throw new Error("native refused"); }).then(value => {finished=true; return value;});
  await Promise.resolve(); expect(finished).toBe(false); expect(copies).toBe(0);
  pending.resolve(); expect(await result).toEqual({ok:true}); expect(copies).toBe(1); expect(document.activeElement).toBe(focus);
  Object.defineProperty(navigator, "clipboard", {configurable:true, value:undefined});
  expect(await copyText("plain HTTP copy")).toEqual({ok:true}); expect(copies).toBe(2);
  Object.defineProperty(document, "execCommand", {configurable:true, value:()=>false});
  expect(await copyText("plain HTTP copy")).toMatchObject({ok:false, code:"clipboard-unavailable"});
 } finally {
  focus.remove();
  if(original) Object.defineProperty(document, "execCommand", original);
  else delete (document as unknown as {execCommand?:unknown}).execCommand;
 }
});
