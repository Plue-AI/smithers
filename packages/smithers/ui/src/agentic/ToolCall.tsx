/** @jsxImportSource react */
import {
  createContext,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import { cn } from "../cn";
import { safeImageSrc } from "../internal/safeImageSrc";
import { CodeBlock } from "../primitives/CodeBlock";
import { StatusPill } from "../status-pill";
import { useInjectUiCss } from "../styles";
import { formatJsonSafe } from "./formatJsonSafe";
import { formatPartialJson } from "./formatPartialJson";

export type ToolCallState =
  | "input-streaming"
  | "input-available"
  | "approval-requested"
  | "approval-responded"
  | "running"
  | "output-available"
  | "output-error"
  | "output-denied";

export const TOOL_CALL_STATE_LABELS: Readonly<Record<ToolCallState, string>> = {
  "input-streaming": "Streaming input",
  "input-available": "Ready",
  "approval-requested": "Needs approval",
  "approval-responded": "Approved",
  running: "Running",
  "output-available": "Done",
  "output-error": "Failed",
  "output-denied": "Denied",
};

/** Map the tool lifecycle onto the shared status vocabulary. */
export function toolCallStatus(
  state: ToolCallState,
): "running" | "pending" | "waiting-approval" | "complete" | "error" | "denied" {
  switch (state) {
    case "input-streaming":
    case "running":
      return "running";
    case "input-available":
    case "approval-responded":
      return "pending";
    case "approval-requested":
      return "waiting-approval";
    case "output-available":
      return "complete";
    case "output-error":
      return "error";
    case "output-denied":
      return "denied";
  }
}

/** A single tool result part: text, json, image, code, or error. */
export type ToolResultPart =
  | { kind: "text"; id?: string; text: string; partial?: boolean }
  | { kind: "json"; id?: string; value?: unknown; jsonText?: string; partial?: boolean }
  | { kind: "image"; id?: string; src: string; alt: string; width?: number; height?: number }
  | { kind: "code"; id?: string; code: string; language?: string; partial?: boolean }
  | { kind: "error"; id?: string; message: string };

type ToolCallOpenable = {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
};

export type ToolCallProps = Omit<ComponentProps<"div">, "children"> &
  ToolCallOpenable & {
    name: string;
    state: ToolCallState;
    durationMs?: number;
    children: ReactNode;
  };

type ToolCallContextValue = {
  name: string;
  state: ToolCallState;
  open: boolean;
  bodyId: string;
  durationMs?: number;
  toggle: () => void;
};

const ToolCallContext = createContext<ToolCallContextValue | null>(null);

function useToolCallContext(part: string): ToolCallContextValue {
  const context = useContext(ToolCallContext);
  if (!context) throw new Error(`${part} must be rendered inside <ToolCall>`);
  return context;
}

function isTerminalToolState(state: ToolCallState): boolean {
  return state === "output-available" || state === "output-error" || state === "output-denied";
}

function formatDurationMs(durationMs: number): string {
  if (durationMs < 1000) return `${Math.round(durationMs)}ms`;
  if (durationMs < 60_000) return `${(durationMs / 1000).toFixed(1)}s`;
  const minutes = Math.floor(durationMs / 60_000);
  const seconds = Math.round((durationMs % 60_000) / 1000);
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

function useToolCallInjected() {
  useInjectUiCss();
}

/** One polite announcement region per ToolCall (state labels + completion). */
function ToolCallLiveRegion({ announcement }: { announcement: string }) {
  return (
    <span data-slot="tool-call-live" className="sui-sr-only" aria-live="polite">
      {announcement}
    </span>
  );
}

function useToolCallAnnouncement(state: ToolCallState, outputComplete: boolean): string {
  const [announcement, setAnnouncement] = useState("");
  const previousLabel = useRef(TOOL_CALL_STATE_LABELS[state]);
  const previousComplete = useRef(outputComplete);

  useEffect(() => {
    const label = TOOL_CALL_STATE_LABELS[state];
    if (label !== previousLabel.current) {
      previousLabel.current = label;
      setAnnouncement(label);
      return;
    }
    if (outputComplete && !previousComplete.current) {
      setAnnouncement("Tool output complete");
    }
    previousComplete.current = outputComplete;
  }, [state, outputComplete]);

  return announcement;
}

/** Tool invocation status, input, output, and approval surface. */
export function ToolCall(props: ToolCallProps) {
  useToolCallInjected();
  const {
    name,
    state,
    durationMs,
    open: controlledOpen,
    defaultOpen = false,
    onOpenChange,
    className,
    children,
    ...rest
  } = props;

  const bodyId = `${useId()}-tool-call-body`;
  const isControlled = controlledOpen !== undefined;
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  const isOpen = isControlled ? controlledOpen : uncontrolledOpen;

  function toggle() {
    const next = !isOpen;
    if (!isControlled) setUncontrolledOpen(next);
    onOpenChange?.(next);
  }

  const announcement = useToolCallAnnouncement(state, state === "output-available");
  return (
    <ToolCallContext.Provider value={{ name, state, open: isOpen, bodyId, durationMs, toggle }}>
      <div
        data-slot="tool-call"
        data-state={isOpen ? "open" : "closed"}
        data-layout="compound"
        className={cn("sui-toolcall", className)}
        {...rest}
      >
        {children}
        <ToolCallLiveRegion announcement={announcement} />
      </div>
    </ToolCallContext.Provider>
  );
}

export type ToolCallHeaderProps = ComponentProps<"div">;

/**
 * Compound-mode header row (a real div per the frozen Div contract) wrapping
 * the disclosure trigger button with name, status, and duration.
 */
export function ToolCallHeader({ className, children, ...props }: ToolCallHeaderProps) {
  useToolCallInjected();
  const context = useToolCallContext("ToolCallHeader");
  const duration =
    context.durationMs != null && isTerminalToolState(context.state) ? (
      <span data-slot="tool-call-duration" className="sui-toolcall-duration">
        {formatDurationMs(context.durationMs)}
      </span>
    ) : null;
  return (
    <div data-slot="tool-call-header" className={cn("sui-toolcall-header", className)} {...props}>
      <button
        type="button"
        data-slot="tool-call-trigger"
        className="sui-toolcall-trigger"
        aria-expanded={context.open}
        aria-controls={context.bodyId}
        onClick={context.toggle}
      >
        {children ?? (
          <>
            <span className="sui-toolcall-chevron" aria-hidden="true">
              ›
            </span>
            <span className="sui-toolcall-name">{context.name}</span>
            <StatusPill status={toolCallStatus(context.state)} label={TOOL_CALL_STATE_LABELS[context.state]} />
            {duration}
          </>
        )}
      </button>
    </div>
  );
}

export type ToolCallContentProps = ComponentProps<"div">;

/** Compound-mode body region (upstream `ToolContent`; naming divergence). */
export function ToolCallContent({ className, ...props }: ToolCallContentProps) {
  useToolCallInjected();
  const context = useToolCallContext("ToolCallContent");
  if (!context.open) return null;
  return (
    <div
      role="region"
      aria-label={`Tool details: ${context.name}`}
      id={context.bodyId}
      data-slot="tool-call-content"
      className={cn("sui-toolcall-body", className)}
      {...props}
    />
  );
}

export type ToolCallInputProps = Omit<ComponentProps<"div">, "children"> & {
  args?: unknown;
  argsText?: string;
  partial?: boolean;
  children?: ReactNode;
};

/** Tool input section; partial streams argsText verbatim, never repaired. */
export function ToolCallInput({ args, argsText, partial = false, children, className, ...props }: ToolCallInputProps) {
  useToolCallInjected();
  const context = useToolCallContext("ToolCallInput");
  let content: ReactNode = children;
  if (content === undefined) {
    const text = partial
      ? (argsText ?? "")
      : argsText !== undefined
        ? formatPartialJson(argsText).text
        : formatJsonSafe(args);
    content = (
      <pre
        className="sui-toolcall-pre"
        data-partial={partial ? "true" : "false"}
        role="region"
        aria-label={`Tool input: ${context.name}`}
        tabIndex={0}
      >
        {text}
      </pre>
    );
  }
  return (
    <div data-slot="tool-call-input" className={cn("sui-toolcall-section", className)} {...props}>
      <div className="sui-toolcall-section-title" data-shimmer={partial ? "true" : "false"}>
        Input
      </div>
      {content}
    </div>
  );
}

function ToolResultPartView({ part, name }: { part: ToolResultPart; name: string }) {
  switch (part.kind) {
    case "text":
      return (
        <pre
          className="sui-toolcall-pre"
          data-partial={part.partial ? "true" : "false"}
          role="region"
          aria-label={`Tool output: ${name}`}
          tabIndex={0}
        >
          {part.text}
        </pre>
      );
    case "json": {
      const text = part.value !== undefined ? formatJsonSafe(part.value) : formatPartialJson(part.jsonText ?? "").text;
      return (
        <pre
          className="sui-toolcall-pre"
          data-partial={part.partial ? "true" : "false"}
          role="region"
          aria-label={`Tool output: ${name}`}
          tabIndex={0}
        >
          {text}
        </pre>
      );
    }
    case "image": {
      const src = safeImageSrc(part.src);
      return src === undefined ? (
        <span className="sui-toolcall-part-image" data-blocked="true">{part.alt}</span>
      ) : (
        <img
          className="sui-toolcall-part-image"
          src={src}
          alt={part.alt}
          width={part.width}
          height={part.height}
        />
      );
    }
    case "code":
      return (
        <div className="sui-toolcall-part" data-partial={part.partial ? "true" : "false"}>
          <CodeBlock code={part.code} language={part.language} showCopy={!part.partial} />
        </div>
      );
    case "error":
      return <ToolCallError message={part.message} />;
  }
}

export type ToolCallOutputProps = Omit<ComponentProps<"div">, "children"> & {
  result?: unknown;
  resultText?: string;
  parts?: readonly ToolResultPart[];
  children?: ReactNode;
};

/** Tool output section: structured parts or custom children. */
export function ToolCallOutput({ result, resultText, parts, children, className, ...props }: ToolCallOutputProps) {
  useToolCallInjected();
  const context = useToolCallContext("ToolCallOutput");
  const anyPartial = parts?.some((part) => "partial" in part && part.partial) ?? false;
  let content: ReactNode = children;
  if (content === undefined) {
    content = parts ? (
      parts.map((part, index) => (
        <ToolResultPartView key={part.id ?? `${part.kind}:${index}`} part={part} name={context.name} />
      ))
    ) : (
      <pre className="sui-toolcall-pre" role="region" aria-label={`Tool output: ${context.name}`} tabIndex={0}>
        {resultText ?? formatJsonSafe(result)}
      </pre>
    );
  }
  return (
    <div data-slot="tool-call-output" className={cn("sui-toolcall-section", className)} {...props}>
      <div className="sui-toolcall-section-title" data-shimmer={anyPartial ? "true" : "false"}>
        Output
      </div>
      {content}
    </div>
  );
}

export type ToolCallErrorProps = Omit<ComponentProps<"div">, "children"> & {
  message?: string;
  children?: ReactNode;
};

/** Destructive tool failure presentation. */
export function ToolCallError({ message, children, className, ...props }: ToolCallErrorProps) {
  useToolCallInjected();
  return (
    <div data-slot="tool-call-error" role="alert" className={cn("sui-toolcall-error-box", className)} {...props}>
      {children ?? message ?? "Tool call failed"}
    </div>
  );
}

export type ToolCallApprovalProps = ComponentProps<"div">;

/** Approval-request presentation container (typically hosts a Confirmation). */
export function ToolCallApproval({ className, ...props }: ToolCallApprovalProps) {
  useToolCallInjected();
  return <div data-slot="tool-call-approval" className={cn("sui-toolcall-approval", className)} {...props} />;
}
