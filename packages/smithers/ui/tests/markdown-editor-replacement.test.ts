import { describe, expect, test } from "bun:test";
import { Schema, type Node } from "@milkdown/kit/prose/model";
import { EditorState, TextSelection } from "@milkdown/kit/prose/state";
import { history, undo } from "@milkdown/kit/prose/history";
import { externalDocumentTransaction } from "../src/adapters/markdown-editor/replaceMarkdown";

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { group: "block", content: "inline*" },
    heading: { group: "block", content: "inline*", attrs: { id: { default: "" }, level: { default: 1 } } },
    text: { group: "inline" },
    image: { group: "inline", inline: true, attrs: { src: {} } },
  },
  marks: { strong: {} },
});
const p = (text = "") => schema.node("paragraph", null, text ? schema.text(text) : undefined);
const h = (text: string, id = "", level = 1) => schema.node("heading", { id, level }, schema.text(text));
const doc = (...nodes: Node[]) => schema.node("doc", null, nodes);
const stateAt = (document: Node, anchor: number, head = anchor) => EditorState.create({
  doc: document, selection: TextSelection.create(document, anchor, head), plugins: [history()],
});
const apply = (state: EditorState, next: Node) => {
  const transaction = externalDocumentTransaction(state, next);
  expect(transaction).not.toBeNull();
  return state.apply(transaction!);
};

describe("external Markdown replacement", () => {
  test("maps a caret past a peer paragraph without replacing unchanged generated headings", () => {
    const before = doc(h("Architecture", "architecture"), p("Colla"), h("Wiki", "wiki"));
    const cursor = before.child(0).nodeSize + 6;
    const prefix = p("Peer note.");
    const after = apply(stateAt(before, cursor), doc(prefix, h("Architecture"), p("Colla"), h("Wiki")));
    expect(after.selection.anchor).toBe(cursor + prefix.nodeSize);
    expect(after.selection.$head.parent.textContent).toBe("Colla");
    expect(after.doc.child(1).attrs.id).toBe("architecture");
    expect(after.doc.child(3).attrs.id).toBe("wiki");
  });

  test("preserves a backwards selection between two disjoint peer changes", () => {
    const before = doc(p("First"), p("Colla"), p("Last"));
    const offset = before.child(0).nodeSize;
    const prefix = p("Peer note.");
    const after = apply(stateAt(before, offset + 6, offset + 4), doc(prefix, p("First"), p("Colla"), p("Changed last")));
    expect(after.selection.anchor).toBe(offset + 6 + prefix.nodeSize);
    expect(after.selection.head).toBe(offset + 4 + prefix.nodeSize);
    expect(after.doc.textBetween(after.selection.from, after.selection.to)).toBe("la");
  });

  test("retains local undo without undoing a peer insertion", () => {
    let state = stateAt(doc(p("Start ")), 7);
    state = state.apply(state.tr.insertText("Colla"));
    state = apply(state, doc(p("Peer note."), p("Start Colla")));
    expect(undo(state, transaction => { state = state.apply(transaction); })).toBe(true);
    expect(state.doc.eq(doc(p("Peer note."), p("Start ")))).toBe(true);
  });

  test("applies formatting, heading level and image source changes", () => {
    const before = doc(h("Title", "title"), p("plain"), schema.node("paragraph", null, schema.node("image", { src: "old.png" })));
    const next = doc(h("Title", "", 2), schema.node("paragraph", null, schema.text("plain", [schema.mark("strong")])),
      schema.node("paragraph", null, schema.node("image", { src: "new.png" })));
    const after = apply(stateAt(before, 2), next);
    expect(after.doc.child(0).attrs.level).toBe(2);
    expect(after.doc.child(1).firstChild!.marks[0]!.type.name).toBe("strong");
    expect(after.doc.child(2).firstChild!.attrs.src).toBe("new.png");
  });

  test("maps a deleted selection to a valid text position", () => {
    const before = doc(p("First"), p("Removed"), p("Last"));
    const next = doc(p("First"), p("Last"));
    const after = apply(stateAt(before, 10, 13), next);
    expect(after.doc.eq(next)).toBe(true);
    expect(after.selection.$head.parent.isTextblock).toBe(true);
    expect(after.selection.from).toBeLessThanOrEqual(after.doc.content.size);
  });

  for (const [before, next] of [["aaaa", "aaaaa"], ["aaaaa", "aaaa"], ["🙂 seed", "🙂 peer seed"], ["text", ""], ["", "text"]]) {
    test(`retains exact content for ${JSON.stringify(before)} → ${JSON.stringify(next)}`, () => {
      const after = apply(stateAt(doc(p(before)), 1), doc(p(next)));
      expect(after.doc.eq(doc(p(next)))).toBe(true);
    });
  }

  test("does not dispatch for equivalent parsed content or regenerated heading ids", () => {
    const before = doc(h("Title", "title"), p("same"));
    expect(externalDocumentTransaction(stateAt(before, 2), doc(h("Title"), p("same")))).toBeNull();
  });
});
