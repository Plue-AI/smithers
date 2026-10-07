/** @jsxImportSource react */
import type { ComponentProps } from "react";
import { cn } from "../cn";
import { canCopyText, type CopyFailureCode } from "../internal/copyToClipboard";
import { useCopyFeedback } from "../internal/useCopyFeedback";
import { useInjectUiCss } from "../styles";

export type SnippetProps = Omit<ComponentProps<"div">, "children"> & {
  code: string;
  language?: string;
  onCopyCode?: (code: string) => void | Promise<void>;
  onCopyError?: (error: { code: CopyFailureCode; cause: unknown; }) => void;
};

/**
 * One-line command/code chip with a copy affordance. Copy seam matches
 * CodeBlock: onCopyCode wins, else navigator.clipboard when available, else
 * the button is hidden.
 */
export function Snippet({ code, language, onCopyCode, onCopyError, className, ...props }: SnippetProps) {
  useInjectUiCss();
  const { copied, copyFailed, copy: copyCode } = useCopyFeedback({ value: code, onCopy: onCopyCode, onCopyError });
  const hasClipboard = canCopyText();
  const canCopy = onCopyCode !== undefined || hasClipboard;


  return (
    <div
      data-slot="snippet"
      data-language={language}
      data-copied={copied ? "true" : "false"}
      className={cn("sui-snippet", className)}
      {...props}
      data-copy-failed={copyFailed ? "true" : undefined}
    >
      <code className="sui-snippet-code">{code}</code>
      {canCopy ?
        (
          <button
            type="button"
            data-slot="snippet-copy"
            className="sui-snippet-copy"
            aria-label="Copy code"
            onClick={() => {
              void copyCode();
            }}
          >
            {copied ? "Copied" : "Copy"}
          </button>
        ) :
        null}
    </div>
  );
}
