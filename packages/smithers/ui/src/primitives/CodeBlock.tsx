/** @jsxImportSource react */
import {
  type ComponentProps,
  createContext,
  type KeyboardEvent,
  type ReactNode,
  useContext,
  useId,
  useRef,
  useState,
} from "react";
import { cn } from "../cn";
import { canCopyText, type CopyFailureCode } from "../internal/copyToClipboard";
import { useCopyFeedback } from "../internal/useCopyFeedback";
import { useInjectUiCss } from "../styles";

export type HighlightedToken = { text: string; color?: string; };
export type HighlightLine = readonly HighlightedToken[];
export type CodeBlockHighlighter = (code: string, language: string | undefined) => readonly HighlightLine[] | null;

export type CodeBlockProps = Omit<ComponentProps<"div">, "onCopy" | "children"> & {
  code: string;
  language?: string;
  showLineNumbers?: boolean;
  wrap?: boolean;
  defaultWrap?: boolean;
  onWrapChange?: (wrap: boolean) => void;
  showCopy?: boolean;
  onCopyCode?: (code: string) => void | Promise<void>;
  onCopyError?: (error: { code: CopyFailureCode; cause: unknown; }) => void;
  copiedDurationMs?: number;
  highlight?: CodeBlockHighlighter;
};

/** Dependency-free fenced code with copy, wrapping, line numbers, and a highlighter seam. */
export function CodeBlock({
  code,
  language,
  showLineNumbers = false,
  wrap: controlledWrap,
  defaultWrap = false,
  onWrapChange,
  showCopy = true,
  onCopyCode,
  onCopyError,
  copiedDurationMs = 2_000,
  highlight,
  className,
  ...props
}: CodeBlockProps) {
  useInjectUiCss();
  const [uncontrolledWrap, setUncontrolledWrap] = useState(defaultWrap);
  const { copied, copyFailed, copy: copyCode } = useCopyFeedback({ value: code, onCopy: onCopyCode, onCopyError, copiedDurationMs });
  const isWrapControlled = controlledWrap !== undefined;
  const wrap = isWrapControlled ? controlledWrap : uncontrolledWrap;
  const hasClipboard = canCopyText();
  const canCopy = showCopy && (onCopyCode !== undefined || hasClipboard);

  let highlighted: readonly HighlightLine[] | null = null;
  if (highlight) {
    try {
      highlighted = highlight(code, language) ?? null;
    } catch {
      highlighted = null;
    }
  }
  const lines: readonly HighlightLine[] = highlighted ?? code.split("\n").map((line) => [{ text: line }]);

  function toggleWrap() {
    const next = !wrap;
    if (!isWrapControlled) setUncontrolledWrap(next);
    onWrapChange?.(next);
  }


  return (
    <div
      data-slot="code-block"
      data-wrap={wrap ? "true" : "false"}
      data-copied={copied ? "true" : "false"}
      className={cn("sui-codeblock", className)}
      {...props}
      data-copy-failed={copyFailed ? "true" : undefined}
    >
      <div data-slot="code-block-header" className="sui-codeblock-header">
        {language !== undefined ? <span className="sui-codeblock-lang">{language}</span> : null}
        <span className="sui-codeblock-actions">
          <button
            type="button"
            data-slot="code-block-wrap"
            className="sui-codeblock-action"
            aria-pressed={wrap}
            aria-label="Toggle line wrap"
            onClick={toggleWrap}
          >
            {wrap ? "Unwrap" : "Wrap"}
          </button>
          {canCopy ?
            (
              <button
                type="button"
                data-slot="code-block-copy"
                className="sui-codeblock-action"
                aria-label="Copy code"
                onClick={() => {
                  void copyCode();
                }}
              >
                {copied ? "Copied" : "Copy"}
              </button>
            ) :
            null}
        </span>
      </div>
      <pre
        data-slot="code-block-body"
        className="sui-codeblock-body"
        role="region"
        aria-label={language ? `${language} code` : "Code"}
        tabIndex={0}
      >
        <code>
          {lines.map((line, lineIndex) => (
            <span key={lineIndex}>
              {showLineNumbers ? (
                <span className="sui-codeblock-lineno" aria-hidden="true">
                  {lineIndex + 1}
                </span>
              ) : null}
              {line.map((token, tokenIndex) => (
                <span key={tokenIndex} style={token.color ? { color: token.color } : undefined}>
                  {token.text}
                </span>
              ))}
              {lineIndex < lines.length - 1 ? "\n" : null}
            </span>
          ))}
        </code>
      </pre>
    </div>
  );
}

export type CodeBlockHeaderProps = ComponentProps<"div">;

/** Custom header row slot for code block compositions. */
export function CodeBlockHeader({ className, ...props }: CodeBlockHeaderProps) {
  useInjectUiCss();
  return <div data-slot="code-block-header" className={cn("sui-codeblock-header", className)} {...props} />;
}

export type CodeBlockFilenameProps = Omit<ComponentProps<"span">, "children"> & {
  name: string;
  icon?: ReactNode;
};

/** Monospace filename chip for code block headers. */
export function CodeBlockFilename({ name, icon, className, ...props }: CodeBlockFilenameProps) {
  useInjectUiCss();
  return (
    <span data-slot="code-block-filename" className={cn("sui-codeblock-filename", className)} {...props}>
      {icon != null ? <span aria-hidden="true">{icon}</span> : null}
      {name}
    </span>
  );
}

export type CodeBlockGroupItem = {
  id: string;
  label: string;
  code: string;
  language?: string;
  filename?: string;
};

export type CodeBlockTabsProps = Omit<ComponentProps<"div">, "children"> & {
  items: readonly { id: string; label: string; }[];
  activeId: string;
  onActiveIdChange: (id: string) => void;
};

/**
 * Internal wiring between CodeBlockGroup and its CodeBlockTabs: the group owns
 * the id prefix so every tab's aria-controls resolves to a real tabpanel the
 * group renders. DOM ids are derived from the item INDEX, never from the
 * caller's opaque item id, so id/aria-controls/aria-labelledby stay valid no
 * matter what characters an item id contains. Not part of the public props
 * surface.
 */
const CodeBlockTabsIdContext = createContext<string | null>(null);

/**
 * Tab strip for switching between grouped code blocks. Roving tabindex keeps
 * only the active tab in the tab order; arrow-key navigation is computed from
 * the focused tab and selection follows focus (automatic activation). Inside a
 * CodeBlockGroup each tab is wired to the group's tabpanels via
 * id/aria-controls; standalone usage renders a labelled tablist only and
 * leaves any tab/panel relationship to the host.
 */
export function CodeBlockTabs({
  items,
  activeId,
  onActiveIdChange,
  className,
  onKeyDown,
  ...props
}: CodeBlockTabsProps) {
  useInjectUiCss();
  const idPrefix = useContext(CodeBlockTabsIdContext);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    onKeyDown?.(event);
    if (event.defaultPrevented) return;
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    if (items.length === 0) return;
    const focusedIndex = tabRefs.current.findIndex((el) => el !== null && el === event.target);
    const activeIndex = Math.max(
      0,
      items.findIndex((item) => item.id === activeId),
    );
    const index = focusedIndex >= 0 ? focusedIndex : activeIndex;
    const next = event.key === "ArrowRight" ? (index + 1) % items.length : (index - 1 + items.length) % items.length;
    event.preventDefault();
    onActiveIdChange(items[next]!.id);
    tabRefs.current[next]?.focus();
  }

  return (
    <div
      role="tablist"
      aria-label="Code blocks"
      data-slot="code-block-tabs"
      className={cn("sui-codeblock-tabs", className)}
      onKeyDown={handleKeyDown}
      {...props}
    >
      {items.map((item, index) => (
        <button
          key={item.id}
          ref={(el) => {
            tabRefs.current[index] = el;
          }}
          type="button"
          role="tab"
          id={idPrefix ? `${idPrefix}-tab-${index}` : undefined}
          aria-controls={idPrefix ? `${idPrefix}-panel-${index}` : undefined}
          data-slot="code-block-tab"
          className="sui-codeblock-tab"
          aria-selected={item.id === activeId}
          tabIndex={item.id === activeId ? 0 : -1}
          onClick={() => onActiveIdChange(item.id)}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

export type CodeBlockGroupProps = Omit<ComponentProps<"div">, "children"> & {
  items: readonly CodeBlockGroupItem[];
  activeId?: string;
  defaultActiveId?: string;
  onActiveIdChange?: (id: string) => void;
  showLineNumbers?: boolean;
  highlight?: CodeBlockHighlighter;
};

/** Tabbed group of related code blocks sharing one frame. */
export function CodeBlockGroup({
  items,
  activeId: controlledActiveId,
  defaultActiveId,
  onActiveIdChange,
  showLineNumbers,
  highlight,
  className,
  ...props
}: CodeBlockGroupProps) {
  useInjectUiCss();
  const baseId = useId();
  const isControlled = controlledActiveId !== undefined;
  const [uncontrolledActiveId, setUncontrolledActiveId] = useState(() => defaultActiveId ?? items[0]?.id ?? "");
  const currentId = isControlled ? controlledActiveId : uncontrolledActiveId;
  const active = items.find((item) => item.id === currentId) ?? items[0];

  function setActive(id: string) {
    if (!isControlled) setUncontrolledActiveId(id);
    onActiveIdChange?.(id);
  }

  return (
    <div data-slot="code-block-group" className={cn("sui-codeblock-group", className)} {...props}>
      <CodeBlockTabsIdContext.Provider value={baseId}>
        {items.length ?
          (
            <CodeBlockHeader className="sui-codeblock-group-header">
              <CodeBlockTabs
                items={items.map(({ id, label }) => ({ id, label }))}
                activeId={active!.id}
                onActiveIdChange={setActive}
              />
              {active!.filename !== undefined ? <CodeBlockFilename name={active!.filename} /> : null}
            </CodeBlockHeader>
          ) :
          null}
        {items.map((item, index) => (
          <div
            key={item.id}
            role="tabpanel"
            id={`${baseId}-panel-${index}`}
            aria-labelledby={`${baseId}-tab-${index}`}
            hidden={item.id !== active?.id}
          >
            <CodeBlock
              code={item.code}
              language={item.language}
              showLineNumbers={showLineNumbers}
              highlight={highlight}
            />
          </div>
        ))}
      </CodeBlockTabsIdContext.Provider>
    </div>
  );
}
