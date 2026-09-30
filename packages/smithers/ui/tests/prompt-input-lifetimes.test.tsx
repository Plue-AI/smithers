/** @jsxImportSource react */
// Attachment lifetimes and the flags every intake path has to honor.
//
// `addFiles` is the single admission point: the hook, paste, form drop and the
// document-level drop registry all reach it without passing the hidden file
// input, so anything the input enforces has to be enforced there too.
import { afterEach, describe, expect, test } from "bun:test";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  PromptInput,
  type PromptInputError,
  type PromptInputMessage,
  PromptInputTextarea,
  usePromptInputAttachments,
} from "../src/prompt/PromptInput";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement | undefined;
let root: Root | undefined;

afterEach(async () => {
  if (root) {
    const mounted = root;
    await act(async () => mounted.unmount());
    root = undefined;
  }
  container?.remove();
  container = undefined;
});

async function render(element: ReactElement): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const mounted = root;
  await act(async () => mounted.render(element));
}

const makeFile = (name: string, type: string) => new File(["x"], name, { type });

function pressEnter(el: HTMLTextAreaElement): void {
  el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
}

function typeText(text: string): void {
  const el = textarea();
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!;
  setter.call(el, text);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

function textarea(): HTMLTextAreaElement {
  const el = container?.querySelector<HTMLTextAreaElement>("textarea");
  if (!el) throw new Error("textarea not found");
  return el;
}

/** Stub URL.createObjectURL / revokeObjectURL and report what was minted. */
async function withObjectUrls<T>(body: (log: { created: string[]; revoked: string[] }) => Promise<T>): Promise<T> {
  const created: string[] = [];
  const revoked: string[] = [];
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: () => {
      const url = `blob:lifetime-${created.length}`;
      created.push(url);
      return url;
    },
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    value: (url: string) => revoked.push(url),
  });
  try {
    return await body({ created, revoked });
  } finally {
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: originalCreate });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: originalRevoke });
  }
}

describe("an async onSubmit borrows attachments for its whole lifetime", () => {
  test("the object URL is still live inside the handler and revoked only after it resolves", async () => {
    await withObjectUrls(async ({ revoked }) => {
      let hook!: ReturnType<typeof usePromptInputAttachments>;
      let release!: () => void;
      const seenInsideHandler: Array<string | undefined> = [];
      const revokedAtResume: string[][] = [];

      function Harness() {
        hook = usePromptInputAttachments();
        return <PromptInputTextarea />;
      }
      await render(
        <PromptInput
          defaultValue="submitted draft"
          onSubmit={async (message: PromptInputMessage) => {
            await new Promise<void>((resolve) => {
              release = resolve;
            });
            // After the first await: this is exactly where a real consumer
            // uploads the blob. The URL must not have been revoked yet.
            seenInsideHandler.push(message.attachments[0]?.url);
            revokedAtResume.push([...revoked]);
          }}
        >
          <Harness />
        </PromptInput>,
      );

      await act(async () => hook.add([makeFile("shot.png", "image/png")]));
      await act(async () => pressEnter(textarea()));
      expect(revoked).toEqual([]);

      await act(async () => {
        release();
        await Promise.resolve();
      });

      expect(seenInsideHandler).toEqual(["blob:lifetime-0"]);
      expect(revokedAtResume).toEqual([[]]);
      expect(revoked).toEqual(["blob:lifetime-0"]);
      expect(textarea().value).toBe("");
      expect(hook.attachments).toEqual([]);
    });
  });

  test("a rejecting onSubmit keeps the draft and reports submit-failed with the cause", async () => {
    const cause = new Error("network down");
    const errors: PromptInputError[] = [];
    await render(
      <PromptInput
        defaultValue="keep me"
        onSubmit={async () => {
          throw cause;
        }}
        onError={(error) => errors.push(error)}
      >
        <PromptInputTextarea />
      </PromptInput>,
    );

    await act(async () => {
      pressEnter(textarea());
      await Promise.resolve();
    });

    expect(textarea().value).toBe("keep me");
    expect(errors).toEqual([
      { code: "submit-failed", message: "The prompt could not be submitted.", cause },
    ]);
  });

  test("a synchronously throwing onSubmit keeps the draft and attachments and reports submit-failed", async () => {
    await withObjectUrls(async ({ revoked }) => {
      const cause = new Error("host threw");
      const errors: PromptInputError[] = [];
      let hook!: ReturnType<typeof usePromptInputAttachments>;
      function Harness() {
        hook = usePromptInputAttachments();
        return <PromptInputTextarea />;
      }
      await render(
        <PromptInput
          defaultValue="keep me"
          onSubmit={() => {
            throw cause;
          }}
          onError={(error) => errors.push(error)}
        >
          <Harness />
        </PromptInput>,
      );
      await act(async () => hook.add([makeFile("shot.png", "image/png")]));

      await act(async () => {
        pressEnter(textarea());
        await Promise.resolve();
      });

      expect(textarea().value).toBe("keep me");
      expect(hook.attachments.map((item) => item.name)).toEqual(["shot.png"]);
      expect(revoked).toEqual([]);
      expect(errors).toEqual([
        { code: "submit-failed", message: "The prompt could not be submitted.", cause },
      ]);
    });
  });

  test.each(["unsent second draft", "submitted draft"])("pending acceptance preserves edited text (%s) and later attachments", async (laterText) => {
    await withObjectUrls(async ({ revoked }) => {
      let hook!: ReturnType<typeof usePromptInputAttachments>;
      let release!: () => void;
      const submitted: PromptInputMessage[] = [];
      function Harness() {
        hook = usePromptInputAttachments();
        return <PromptInputTextarea />;
      }
      const view = (status: "ready" | "submitted") => (
        <PromptInput
          multiple
          defaultValue="submitted draft"
          status={status}
          onSubmit={async (message) => {
            submitted.push(message);
            await new Promise<void>((resolve) => {
              release = resolve;
            });
          }}
        >
          <Harness />
        </PromptInput>
      );

      await render(view("ready"));

      await act(async () => hook.add([makeFile("first.png", "image/png")]));
      await act(async () => pressEnter(textarea()));
      await act(async () => root!.render(view("submitted")));
      await act(async () => typeText("intermediate edit"));
      await act(async () => typeText(laterText));
      await act(async () => hook.add([makeFile("second.png", "image/png")]));
      const laterAttachment = hook.attachments[1]!;
      expect(submitted.map((message) => ({
        text: message.text,
        files: message.attachments.map((item) => item.name),
      }))).toEqual([{ text: "submitted draft", files: ["first.png"] }]);
      expect(textarea().value).toBe(laterText);
      expect(hook.attachments.map((item) => item.name)).toEqual(["first.png", "second.png"]);
      await act(async () => {
        release();
        await Promise.resolve();
      });

      // Only the submitted attachment's URL is released.
      expect(revoked).toEqual(["blob:lifetime-0"]);
      expect({ text: textarea().value, attachments: hook.attachments }).toEqual({
        text: laterText,
        attachments: [laterAttachment],
      });
      expect(laterAttachment.url).toBe("blob:lifetime-1");
      await act(async () => hook.remove(laterAttachment.id));
      expect(hook.attachments).toEqual([]);
      expect(revoked).toEqual(["blob:lifetime-0", "blob:lifetime-1"]);

      await act(async () => root!.unmount());
      root = undefined;
      expect(revoked).toEqual(["blob:lifetime-0", "blob:lifetime-1"]);
    });
  });
});

describe("removing an attachment while a submission is pending", () => {
  type Hook = ReturnType<typeof usePromptInputAttachments>;

  async function pendingSubmission(
    revoked: string[],
    settle: { current?: (outcome: "resolve" | "reject") => void },
    files: File[],
  ): Promise<() => Hook> {
    let hook!: Hook;
    function Harness() {
      hook = usePromptInputAttachments();
      return <PromptInputTextarea />;
    }
    await render(
      <PromptInput
        defaultValue="draft"
        multiple
        onSubmit={() =>
          new Promise<void>((resolve, reject) => {
            settle.current = (outcome) => (outcome === "resolve" ? resolve() : reject(new Error("boom")));
          })
        }
        onError={() => {}}
      >
        <Harness />
      </PromptInput>,
    );
    await act(async () => hook.add(files));
    await act(async () => pressEnter(textarea()));
    expect(revoked).toEqual([]);
    return () => hook;
  }

  test.each(["resolve", "reject"] as const)("removal defers the revoke until the handler %ss", async (outcome) => {
    await withObjectUrls(async ({ revoked }) => {
      const settle: { current?: (outcome: "resolve" | "reject") => void } = {};
      const hook = await pendingSubmission(revoked, settle, [makeFile("a.png", "image/png"), makeFile("b.png", "image/png")]);

      const [first] = hook().attachments;
      await act(async () => hook().remove(first!.id));
      expect(hook().attachments.map((item) => item.name)).toEqual(["b.png"]);
      expect(revoked).toEqual([]);

      await act(async () => {
        settle.current!(outcome);
        await Promise.resolve();
        await Promise.resolve();
      });
      // Resolve accepts the whole submission; reject keeps the surviving draft
      // attachment alive and revokes only the one the user removed.
      expect(revoked).toEqual(outcome === "resolve" ? ["blob:lifetime-0", "blob:lifetime-1"] : ["blob:lifetime-0"]);
    });
  });

  test("clearing the draft defers the revoke until the handler settles", async () => {
    await withObjectUrls(async ({ revoked }) => {
      const settle: { current?: (outcome: "resolve" | "reject") => void } = {};
      const hook = await pendingSubmission(revoked, settle, [makeFile("a.png", "image/png")]);

      await act(async () => hook().clear());
      expect(hook().attachments).toEqual([]);
      expect(revoked).toEqual([]);

      await act(async () => {
        settle.current!("resolve");
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(revoked).toEqual(["blob:lifetime-0"]);
    });
  });

  test("unmounting revokes even a leased URL", async () => {
    await withObjectUrls(async ({ revoked }) => {
      const settle: { current?: (outcome: "resolve" | "reject") => void } = {};
      await pendingSubmission(revoked, settle, [makeFile("a.png", "image/png")]);
      const mounted = root!;
      root = undefined;
      await act(async () => mounted.unmount());
      expect(revoked).toEqual(["blob:lifetime-0"]);
      await act(async () => {
        settle.current!("resolve");
        await Promise.resolve();
      });
      expect(revoked).toEqual(["blob:lifetime-0"]);
    });
  });

  test("with no submission pending, removal revokes immediately", async () => {
    await withObjectUrls(async ({ revoked }) => {
      let hook!: Hook;
      function Harness() {
        hook = usePromptInputAttachments();
        return <PromptInputTextarea />;
      }
      await render(
        <PromptInput onSubmit={() => {}}>
          <Harness />
        </PromptInput>,
      );
      await act(async () => hook.add([makeFile("a.png", "image/png")]));
      await act(async () => hook.remove(hook.attachments[0]!.id));
      expect(revoked).toEqual(["blob:lifetime-0"]);
    });
  });
});

describe("disabled and multiple bind every intake path, not just the picker", () => {
  test("a disabled prompt refuses files from the hook and reports the code", async () => {
    const errors: PromptInputError[] = [];
    let hook!: ReturnType<typeof usePromptInputAttachments>;
    function Harness() {
      hook = usePromptInputAttachments();
      return <PromptInputTextarea />;
    }
    await render(
      <PromptInput disabled onSubmit={() => {}} onError={(error) => errors.push(error)}>
        <Harness />
      </PromptInput>,
    );

    await act(async () => hook.add([makeFile("blocked.txt", "text/plain")]));
    expect(hook.attachments).toEqual([]);
    expect(errors.map((error) => error.code)).toEqual(["disabled"]);
  });

  test("a disabled prompt refuses a paste and a form drop", async () => {
    let hook!: ReturnType<typeof usePromptInputAttachments>;
    function Harness() {
      hook = usePromptInputAttachments();
      return <PromptInputTextarea />;
    }
    await render(
      <PromptInput disabled onSubmit={() => {}}>
        <Harness />
      </PromptInput>,
    );
    const form = container!.querySelector("form")!;

    const paste = new Event("paste", { bubbles: true, cancelable: true });
    Object.assign(paste, { clipboardData: { files: [makeFile("pasted.txt", "text/plain")] } });
    const drop = new Event("drop", { bubbles: true, cancelable: true });
    Object.assign(drop, { dataTransfer: { files: [makeFile("dropped.txt", "text/plain")] } });
    await act(async () => {
      form.dispatchEvent(paste);
      form.dispatchEvent(drop);
    });

    expect(hook.attachments).toEqual([]);
  });

  test("a disabled prompt claims no document drop registration", async () => {
    let hook!: ReturnType<typeof usePromptInputAttachments>;
    function Harness() {
      hook = usePromptInputAttachments();
      return <PromptInputTextarea />;
    }
    await render(
      <PromptInput disabled globalDrop onSubmit={() => {}}>
        <Harness />
      </PromptInput>,
    );

    const drop = new Event("drop", { bubbles: true, cancelable: true });
    Object.assign(drop, { dataTransfer: { files: [makeFile("dropped.txt", "text/plain")] } });
    await act(async () => {
      document.dispatchEvent(drop);
    });

    expect(hook.attachments).toEqual([]);
  });

  test("multiple=false accepts exactly one file from a batch and reports the rest", async () => {
    const errors: PromptInputError[] = [];
    let hook!: ReturnType<typeof usePromptInputAttachments>;
    function Harness() {
      hook = usePromptInputAttachments();
      return <PromptInputTextarea />;
    }
    await render(
      <PromptInput onSubmit={() => {}} onError={(error) => errors.push(error)}>
        <Harness />
      </PromptInput>,
    );

    await act(async () =>
      hook.add([makeFile("one.txt", "text/plain"), makeFile("two.txt", "text/plain")])
    );
    expect(hook.attachments.map((item) => item.name)).toEqual(["one.txt"]);
    expect(errors.map((error) => error.code)).toEqual(["multiple"]);

    // A second call is refused too: the single slot is already taken.
    await act(async () => hook.add([makeFile("three.txt", "text/plain")]));
    expect(hook.attachments.map((item) => item.name)).toEqual(["one.txt"]);
    expect(errors.map((error) => error.code)).toEqual(["multiple", "multiple"]);
  });

  test("a consumer onPaste that calls preventDefault suppresses the built-in intake", async () => {
    let hook!: ReturnType<typeof usePromptInputAttachments>;
    function Harness() {
      hook = usePromptInputAttachments();
      return <PromptInputTextarea />;
    }
    await render(
      <PromptInput onSubmit={() => {}} onPaste={(event) => event.preventDefault()}>
        <Harness />
      </PromptInput>,
    );
    const form = container!.querySelector("form")!;
    const paste = new Event("paste", { bubbles: true, cancelable: true });
    Object.assign(paste, { clipboardData: { files: [makeFile("pasted.txt", "text/plain")] } });
    await act(async () => {
      form.dispatchEvent(paste);
    });

    expect(hook.attachments).toEqual([]);
  });
});
