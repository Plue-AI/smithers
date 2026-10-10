/** @jsxImportSource react */
// SSR has no layout engine, so the server always emits the textarea. A real
// browser's layout probe answers true, and the first client render must still
// match the server tree; the editor promotes to WYSIWYG only after hydration.
//
// happy-dom measures every element as 0x0, so the probe is made to report a
// real browser's 20x20 here. The module caches its probe, so this file loads a
// fresh module instance that has never measured.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { act } from "react";
import { hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import type * as MarkdownEditorModuleNs from "../src/adapters/markdown-editor/MarkdownEditor";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// happy-dom declares the method on Element.prototype, so HTMLElement.prototype
// usually has no own copy. Restoring by assignment would leave one behind and
// shadow every later stub of Element.prototype in the same process: the
// anchored-scroll case in code-view.test.tsx read 0 instead of 690 whenever
// this file ran first.
const ownRect = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "getBoundingClientRect");
let editor: typeof MarkdownEditorModuleNs;

beforeAll(async () => {
  HTMLElement.prototype.getBoundingClientRect = function () {
    return { x: 0, y: 0, top: 0, left: 0, right: 20, bottom: 20, width: 20, height: 20, toJSON: () => ({}) } as DOMRect;
  };
  const fresh: string = "../src/adapters/markdown-editor/MarkdownEditor.tsx?hydration";
  editor = (await import(fresh)) as typeof MarkdownEditorModuleNs;
});

afterAll(() => {
  if (ownRect === undefined) delete (HTMLElement.prototype as Partial<HTMLElement>).getBoundingClientRect;
  else Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", ownRect);
});

describe("MarkdownEditor hydration", () => {
  test("hydrates the server textarea without a mismatch, then promotes to WYSIWYG", async () => {
    const { MarkdownEditor } = editor;
    // What a real server render emits: no document, so the no-layout textarea.
    const serverHtml = renderToString(<MarkdownEditor value="# seed" fallback />);
    const container = document.createElement("div");
    container.innerHTML = serverHtml;
    document.body.appendChild(container);
    const serverTextarea = container.querySelector("textarea");
    expect(serverTextarea).not.toBeNull();

    const recoverable: unknown[] = [];
    let root!: Root;
    await act(async () => {
      root = hydrateRoot(container, <MarkdownEditor value="# seed" loadEditor={() => new Promise(() => {})} />, {
        onRecoverableError: (error) => recoverable.push(error),
      });
    });

    expect(recoverable).toEqual([]);
    expect(container.querySelector('[data-slot="markdown-editor"]')?.getAttribute("data-mode")).toBe("wysiwyg");

    await act(async () => root.unmount());
    container.remove();
  });
});
