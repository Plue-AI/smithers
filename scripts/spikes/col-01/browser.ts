import * as Y from "yjs";

type Envelope = { kind: string; seq?: number; update?: string; host_in?: string; host_out?: string; host_vm_ns?: string; host_in_elapsed_ns?: string; error?: string };
type LocalOrigin = { local: true; seq: number };
type Receipt = { seq: number; inserted: string; host_in: string; host_out: string; host_vm_ns: string; host_in_elapsed_ns?: string };
declare global {
  interface Window {
    __spikeReceipt(receipt: Receipt): Promise<void>;
    spike: { ready: boolean; errors: string[]; content(): string; type(seq: number, character: string, firstLine: number, lastLine: number, random: number): void };
  }
}

const doc = new Y.Doc();
const content = doc.getText("content");
const errors: string[] = [];
const localSequences = new Set<number>();
const observedSequences = new Set<number>();
let applying: Envelope | undefined;
let observations = 0;
let initialized = false;
const parameters = new URLSearchParams(location.search);
const socketURL = new URL("/ws", location.href);
socketURL.protocol = "ws:";
for (const name of ["room", "transport", "client"]) socketURL.searchParams.set(name, parameters.get(name) ?? "");
const socket = new WebSocket(socketURL);
const decode = (update: string) => Uint8Array.from(atob(update), (character) => character.charCodeAt(0));
const encode = (update: Uint8Array) => btoa(Array.from(update, (byte) => String.fromCharCode(byte)).join(""));

window.spike = {
  ready: false,
  errors,
  content: () => content.toString(),
  type(seq, character, firstLine, lastLine, random) {
    if (!initialized || socket.readyState !== WebSocket.OPEN) throw new Error("Document is not ready");
    if (!Number.isSafeInteger(seq) || localSequences.has(seq)) throw new Error(`Invalid/duplicate local sequence ${seq}`);
    if (character.length !== 1 || character === "\n" || random < 0 || random >= 1) throw new Error("Expected one printable character and random in [0,1)");
    const lines = content.toString().split("\n");
    if (firstLine < 1 || lastLine > lines.length || lastLine < firstLine) throw new Error("Invalid line range");
    const scaled = random * (lastLine - firstLine + 1);
    const line = firstLine - 1 + Math.floor(scaled);
    const column = Math.floor((scaled - Math.floor(scaled)) * (lines[line].length + 1));
    const position = lines.slice(0, line).reduce((sum, text) => sum + text.length + 1, 0) + column;
    localSequences.add(seq);
    doc.transact(() => content.insert(position, character), { local: true, seq } satisfies LocalOrigin);
  },
};

content.observe((event) => {
  if (!applying) return;
  observations++;
  const seq = applying.seq!;
  const inserted = event.delta.map((delta) => typeof delta.insert === "string" ? delta.insert : "").join("");
  if (inserted.length !== 1 || event.delta.some((delta) => delta.delete !== undefined)) {
    errors.push(`Sequence ${seq} did not insert exactly one character`);
    return;
  }
  if (observedSequences.has(seq)) { errors.push(`Duplicate observed sequence ${seq}`); return; }
  observedSequences.add(seq);
  // The runner stamps receipt here, after Y.Text applied the remote change.
  void window.__spikeReceipt({ seq, inserted, host_in: applying.host_in!, host_out: applying.host_out!, host_vm_ns: applying.host_vm_ns!, host_in_elapsed_ns: applying.host_in_elapsed_ns }).catch((error) => errors.push(String(error)));
});

doc.on("update", (update: Uint8Array, origin: LocalOrigin | undefined) => {
  if (origin?.local) socket.send(JSON.stringify({ kind: "update", seq: origin.seq, update: encode(update) }));
});

socket.onmessage = ({ data }) => {
  try {
    const message = JSON.parse(String(data)) as Envelope;
    if (message.kind === "init") {
      if (initialized || !message.update) throw new Error("Invalid duplicate/missing initialization");
      Y.applyUpdate(doc, decode(message.update));
      initialized = true;
      window.spike.ready = true;
      return;
    }
    if (message.kind !== "update" || !initialized || !message.update || !Number.isSafeInteger(message.seq)) throw new Error(message.error ?? "Invalid remote update");
    if (localSequences.has(message.seq!)) return;
    if (observedSequences.has(message.seq!)) throw new Error(`Duplicate remote sequence ${message.seq}`);
    for (const field of ["host_in", "host_out", "host_vm_ns"] as const) if (!/^\d+$/.test(message[field] ?? "")) throw new Error(`Missing monotonic host timestamp ${field}`);
    applying = message;
    observations = 0;
    Y.applyUpdate(doc, decode(message.update));
    if (observations !== 1) throw new Error(`Sequence ${message.seq} generated ${observations} Y.Text observer calls`);
  } catch (error) {
    errors.push(String(error));
  } finally {
    applying = undefined;
  }
};
socket.onerror = () => errors.push("WebSocket error");
socket.onclose = () => { window.spike.ready = false; };
