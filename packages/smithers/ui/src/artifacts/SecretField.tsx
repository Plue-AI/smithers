/** @jsxImportSource react */
import { type ComponentProps, useState } from "react";
import { cn } from "../cn";
import { canCopyText, type CopyFailureCode } from "../internal/copyToClipboard";
import { useCopyFeedback } from "../internal/useCopyFeedback";
import { useInjectUiCss } from "../styles";

export type SecretFieldProps = Omit<ComponentProps<"span">, "children" | "onCopy"> & {
  value: string;
  revealed?: boolean;
  defaultRevealed?: boolean;
  onRevealedChange?: (revealed: boolean) => void;
  /** Extra accessible context appended to the toggle/copy labels. */
  label?: string;
  /** Fixed bullet count shown while masked (default 8, maximum 64); never tracks length. */
  maskLength?: number;
  onCopy?: (value: string) => void | Promise<void>;
  onCopyError?: (error: { code: CopyFailureCode; cause: unknown; }) => void;
};

/**
 * Redacted secret display. While masked the secret string is NOT present
 * anywhere in the DOM — only a fixed-length bullet run. Reveal is a toggle;
 * copy goes through the callback (or clipboard) WITHOUT revealing.
 */
export function SecretField({
  value,
  revealed: controlledRevealed,
  defaultRevealed = false,
  onRevealedChange,
  label,
  maskLength = 8,
  onCopy,
  onCopyError,
  className,
  ...props
}: SecretFieldProps) {
  useInjectUiCss();
  const [uncontrolledRevealed, setUncontrolledRevealed] = useState(defaultRevealed);
  const { copied, copyFailed, copy } = useCopyFeedback({ value, onCopy, onCopyError });
  const isControlled = controlledRevealed !== undefined;
  const revealed = isControlled ? controlledRevealed : uncontrolledRevealed;
  const hasClipboard = canCopyText();
  const canCopy = onCopy !== undefined || hasClipboard;
  const context = label !== undefined ? ` ${label}` : "";
  const normalizedMaskLength = Math.min(64, Math.max(1, Math.trunc(maskLength) || 8));

  function toggle() {
    const next = !revealed;
    if (!isControlled) setUncontrolledRevealed(next);
    onRevealedChange?.(next);
  }


  return (
    <span
      data-slot="secret-field"
      data-revealed={revealed ? "true" : "false"}
      data-copied={copied ? "true" : "false"}
      className={cn("sui-secret", className)}
      {...props}
      data-copy-failed={copyFailed ? "true" : undefined}
    >
      {revealed ? <span className="sui-secret-value">{value}</span> : (
        <>
          <span className="sui-secret-mask" aria-hidden="true">
            {"•".repeat(normalizedMaskLength)}
          </span>
          <span className="sui-sr-only">Hidden secret{context}</span>
        </>
      )}
      <button
        type="button"
        data-slot="secret-field-toggle"
        className="sui-secret-toggle"
        aria-pressed={revealed}
        aria-label={revealed ? `Hide secret${context}` : `Reveal secret${context}`}
        onClick={toggle}
      >
        {revealed ? "Hide" : "Reveal"}
      </button>
      {canCopy ?
        (
          <button
            type="button"
            data-slot="secret-field-copy"
            className="sui-secret-copy"
            aria-label={`Copy secret${context}`}
            onClick={() => {
              void copy();
            }}
          >
            {copied ? "Copied" : "Copy"}
          </button>
        ) :
        null}
    </span>
  );
}
