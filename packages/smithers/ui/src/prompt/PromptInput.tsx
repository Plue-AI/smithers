/** @jsxImportSource react */
import {
  Children,
  createContext,
  isValidElement,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { Attachment, AttachmentGroup } from "../chat/Attachment";
import { cn } from "../cn";
import { Spinner } from "../spinner";
import { useInjectUiCss } from "../styles";
import type { AttachmentState } from "../chat/Attachment";

export type PromptInputAttachmentItem = {
  id: string;
  name: string;
  mediaType?: string;
  sizeBytes?: number;
  url?: string;
  thumbnailUrl?: string;
  state?: AttachmentState;
  progress?: number | null;
  errorText?: string;
  file?: File;
};

export type PromptInputMessage = {
  text: string;
  attachments: readonly PromptInputAttachmentItem[];
};

export type PromptInputStatus = "ready" | "submitted" | "streaming" | "error";

export type PromptInputError = {
  /**
   * `disabled` and `multiple` reject a file the component would not have
   * accepted through its own picker; `submit-failed` reports a rejected
   * `onSubmit`, and is the only code that carries a `cause`.
   */
  code: "max-files" | "max-file-size" | "accept" | "disabled" | "multiple" | "submit-failed";
  message: string;
  file?: File;
  /** The original rejection, retained for `submit-failed`. */
  cause?: unknown;
};

export type PromptInputProps = Omit<ComponentProps<"form">, "onSubmit" | "onError"> & {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  attachments?: readonly PromptInputAttachmentItem[];
  defaultAttachments?: readonly PromptInputAttachmentItem[];
  onAttachmentsChange?: (attachments: readonly PromptInputAttachmentItem[]) => void;
  /**
   * Handles the submitted message. A returned promise is awaited: the draft is
   * held and the component-owned attachment object URLs stay alive until it
   * settles, so an async handler can still read `url`/`thumbnailUrl` after its
   * first `await`. A rejection keeps the draft and reports a `submit-failed`
   * {@link PromptInputError}.
   */
  onSubmit: (message: PromptInputMessage, event: FormEvent<HTMLFormElement>) => void | Promise<void>;
  onStop?: () => void;
  status?: PromptInputStatus;
  submitKey?: "enter" | "mod-enter";
  accept?: string;
  multiple?: boolean;
  maxFiles?: number;
  maxFileSizeBytes?: number;
  globalDrop?: boolean;
  disabled?: boolean;
  onError?: (error: PromptInputError) => void;
};

type PromptInputContextValue = {
  value: string;
  setValue: (value: string) => void;
  attachments: readonly PromptInputAttachmentItem[];
  addFiles: (files: FileList | readonly File[]) => void;
  removeAttachment: (id: string) => void;
  clearAttachments: () => void;
  openFileDialog: () => void;
  status: PromptInputStatus;
  disabled: boolean;
  submitKey: "enter" | "mod-enter";
  onStop?: () => void;
};

const PromptInputContext = createContext<PromptInputContextValue | null>(null);

function usePromptInputContext(): PromptInputContextValue {
  const context = useContext(PromptInputContext);
  if (!context) throw new Error("usePromptInputAttachments must be used within a PromptInput");
  return context;
}

/** Attachment controller for the enclosing PromptInput. Throws outside one. */
export function usePromptInputAttachments(): {
  attachments: readonly PromptInputAttachmentItem[];
  add: (files: FileList | readonly File[]) => void;
  remove: (id: string) => void;
  clear: () => void;
  openFileDialog: () => void;
} {
  const context = usePromptInputContext();
  return {
    attachments: context.attachments,
    add: context.addFiles,
    remove: context.removeAttachment,
    clear: context.clearAttachments,
    openFileDialog: context.openFileDialog,
  };
}

/* -------------------------------------------------------------------------- */
/* globalDrop registry: the most recently mounted globalDrop PromptInput owns */
/* the document drag listeners; unmounting restores the previous registrant.  */
/* -------------------------------------------------------------------------- */

type GlobalDropEntry = {
  add: (files: FileList | readonly File[]) => void;
  setActive: (active: boolean) => void;
};

const globalDropStack: GlobalDropEntry[] = [];

function topGlobalDropEntry(): GlobalDropEntry | undefined {
  return globalDropStack[globalDropStack.length - 1];
}

function handleDocumentDragOver(event: Event) {
  if (event.defaultPrevented) return;
  const top = topGlobalDropEntry();
  if (!top) return;
  event.preventDefault();
  top.setActive(true);
}

function handleDocumentDrop(event: Event) {
  if (event.defaultPrevented) return;
  const top = topGlobalDropEntry();
  if (!top) return;
  event.preventDefault();
  top.setActive(false);
  const dataTransfer = (event as DragEvent).dataTransfer;
  if (dataTransfer && dataTransfer.files && dataTransfer.files.length > 0) {
    top.add(dataTransfer.files);
  }
}

function handleDocumentDragLeave(event: Event) {
  const top = topGlobalDropEntry();
  if (!top) return;
  if (!(event as DragEvent).relatedTarget) top.setActive(false);
}

function attachGlobalDropListeners() {
  document.addEventListener("dragover", handleDocumentDragOver);
  document.addEventListener("drop", handleDocumentDrop);
  document.addEventListener("dragleave", handleDocumentDragLeave);
}

function detachGlobalDropListeners() {
  document.removeEventListener("dragover", handleDocumentDragOver);
  document.removeEventListener("drop", handleDocumentDrop);
  document.removeEventListener("dragleave", handleDocumentDragLeave);
}

/* -------------------------------------------------------------------------- */

function fileMatchesAccept(file: File, accept: string): boolean {
  const tokens = accept
    .split(",")
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean);
  if (tokens.length === 0) return true;
  const name = file.name.toLowerCase();
  const type = (file.type || "").toLowerCase();
  return tokens.some((token) => {
    if (token.startsWith(".")) return name.endsWith(token);
    if (token.endsWith("/*")) return type.startsWith(token.slice(0, -1));
    return type === token;
  });
}

function canCreateObjectUrl(): boolean {
  return typeof URL !== "undefined" && typeof URL.createObjectURL === "function";
}

/**
 * Rich prompt composer root: a form owning text + attachment state, keyboard
 * submission, paste/drag-drop file intake, and the action menu controller.
 */
export function PromptInput({
  value: valueProp,
  defaultValue,
  onValueChange,
  attachments: attachmentsProp,
  defaultAttachments,
  onAttachmentsChange,
  onSubmit,
  onStop,
  status = "ready",
  submitKey = "enter",
  accept,
  multiple = false,
  maxFiles,
  maxFileSizeBytes,
  globalDrop = false,
  disabled = false,
  onError,
  className,
  children,
  onPaste,
  onDragOver,
  onDragLeave,
  onDrop,
  ...props
}: PromptInputProps) {
  useInjectUiCss();
  const idPrefix = useId();
  const idCounter = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const objectUrlsRef = useRef<Map<string, string>>(new Map());
  const [innerValue, setInnerValue] = useState(defaultValue ?? "");
  const valueRevisionRef = useRef(0);
  const [innerAttachments, setInnerAttachments] = useState<readonly PromptInputAttachmentItem[]>(
    defaultAttachments ?? [],
  );
  const [dropActive, setDropActive] = useState(false);
  const [announcement, setAnnouncement] = useState("");

  const value = valueProp !== undefined ? valueProp : innerValue;
  const attachments = attachmentsProp !== undefined ? attachmentsProp : innerAttachments;

  const setValue = useCallback(
    (next: string) => {
      if (valueProp === undefined) {
        valueRevisionRef.current += 1;
        setInnerValue(next);
      }
      onValueChange?.(next);
    },
    [valueProp, onValueChange],
  );

  const setAttachments = useCallback(
    (next: readonly PromptInputAttachmentItem[]) => {
      if (attachmentsProp === undefined) setInnerAttachments(next);
      onAttachmentsChange?.(next);
    },
    [attachmentsProp, onAttachmentsChange],
  );

  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;
  const setAttachmentsRef = useRef(setAttachments);
  setAttachmentsRef.current = setAttachments;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  /**
   * Attachment ids handed to a submission that has not settled, with how many
   * such submissions hold each. Their URLs are borrowed for the whole handler,
   * so removal or clearing defers the revoke until the last holder settles.
   */
  const leasedIdsRef = useRef<Map<string, number>>(new Map());

  /** Revoke everything (unmount) or, with `keepLeased`, all but pending leases. */
  const cleanupObjectUrls = useCallback((keepLeased = false) => {
    const revocable = canCreateObjectUrl();
    for (const [id, objectUrl] of [...objectUrlsRef.current]) {
      if (keepLeased && leasedIdsRef.current.has(id)) continue;
      if (revocable) URL.revokeObjectURL(objectUrl);
      objectUrlsRef.current.delete(id);
    }
  }, []);

  /**
   * Revoke only the URLs this component minted for the given attachments.
   * Submitting waits for an async `onSubmit`, and files added while it was in
   * flight are not part of what was submitted: revoking everything would kill
   * previews the user is still looking at.
   */
  const revokeObjectUrlsFor = useCallback((items: readonly PromptInputAttachmentItem[]) => {
    const revocable = canCreateObjectUrl();
    for (const item of items) {
      const objectUrl = objectUrlsRef.current.get(item.id);
      if (objectUrl === undefined) continue;
      if (revocable) URL.revokeObjectURL(objectUrl);
      objectUrlsRef.current.delete(item.id);
    }
  }, []);

  const addFiles = useCallback(
    (files: FileList | readonly File[]) => {
      // `addFiles` is the single admission point: the hook, paste, form drop and
      // the document-level drop registry all arrive here without passing the
      // hidden `<input>`, so the flags the input enforces have to be enforced
      // here too or they only apply to the picker.
      if (disabled) {
        for (const file of Array.from(files)) {
          onErrorRef.current?.({
            code: "disabled",
            message: "This prompt is disabled and cannot accept attachments.",
            file,
          });
        }
        return;
      }
      const accepted: PromptInputAttachmentItem[] = [];
      for (const file of Array.from(files)) {
        if (!multiple && attachmentsRef.current.length + accepted.length >= 1) {
          onErrorRef.current?.({
            code: "multiple",
            message: "Only one file can be attached.",
            file,
          });
          continue;
        }
        if (maxFiles !== undefined && attachmentsRef.current.length + accepted.length >= maxFiles) {
          onErrorRef.current?.({
            code: "max-files",
            message: `At most ${maxFiles} file${maxFiles === 1 ? "" : "s"} can be attached.`,
            file,
          });
          continue;
        }
        if (maxFileSizeBytes !== undefined && file.size > maxFileSizeBytes) {
          onErrorRef.current?.({
            code: "max-file-size",
            message: `${file.name} exceeds the ${maxFileSizeBytes} byte size limit.`,
            file,
          });
          continue;
        }
        if (accept && !fileMatchesAccept(file, accept)) {
          onErrorRef.current?.({
            code: "accept",
            message: `${file.name} does not match the accepted file types (${accept}).`,
            file,
          });
          continue;
        }
        idCounter.current += 1;
        const id = `${idPrefix}-att-${idCounter.current}`;
        const item: PromptInputAttachmentItem = {
          id,
          name: file.name,
          mediaType: file.type || undefined,
          sizeBytes: file.size,
          state: "ready",
          file,
        };
        if (file.type.startsWith("image/") && canCreateObjectUrl()) {
          const objectUrl = URL.createObjectURL(file);
          objectUrlsRef.current.set(id, objectUrl);
          item.url = objectUrl;
          item.thumbnailUrl = objectUrl;
        }
        accepted.push(item);
      }
      if (accepted.length === 0) return;
      const next = [...attachmentsRef.current, ...accepted];
      attachmentsRef.current = next;
      setAttachmentsRef.current(next);
      setAnnouncement(`${accepted.length === 1 ? accepted[0]!.name : `${accepted.length} files`} attached`);
    },
    [accept, disabled, multiple, maxFiles, maxFileSizeBytes, idPrefix],
  );

  const addFilesRef = useRef(addFiles);
  addFilesRef.current = addFiles;

  const removeAttachment = useCallback((id: string) => {
    const target = attachmentsRef.current.find((item) => item.id === id);
    const objectUrl = objectUrlsRef.current.get(id);
    if (objectUrl && !leasedIdsRef.current.has(id)) {
      if (canCreateObjectUrl()) URL.revokeObjectURL(objectUrl);
      objectUrlsRef.current.delete(id);
    }
    const next = attachmentsRef.current.filter((item) => item.id !== id);
    attachmentsRef.current = next;
    setAttachmentsRef.current(next);
    if (target) setAnnouncement(`${target.name} removed`);
  }, []);

  const clearAttachments = useCallback(() => {
    cleanupObjectUrls(true);
    attachmentsRef.current = [];
    setAttachmentsRef.current([]);
  }, [cleanupObjectUrls]);

  const openFileDialog = useCallback(() => {
    if (disabled) return;
    fileInputRef.current?.click();
  }, [disabled]);

  useEffect(() => {
    return () => {
      cleanupObjectUrls();
    };
  }, [cleanupObjectUrls]);

  useEffect(() => {
    // A disabled prompt claims nothing: registering would make it the document
    // drop owner and steal drops from an enabled prompt behind it.
    if (!globalDrop || disabled || typeof document === "undefined") return;
    const entry: GlobalDropEntry = {
      add: (files) => addFilesRef.current(files),
      setActive: setDropActive,
    };
    globalDropStack.push(entry);
    if (globalDropStack.length === 1) attachGlobalDropListeners();
    return () => {
      const index = globalDropStack.indexOf(entry);
      if (index >= 0) globalDropStack.splice(index, 1);
      if (globalDropStack.length === 0) detachGlobalDropListeners();
    };
  }, [globalDrop, disabled]);

  const busy = status === "submitted" || status === "streaming";

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (disabled || busy) return;
    if (value.trim().length === 0 && attachments.length === 0) return;
    const submitted = attachments;
    const submittedIds = new Set(submitted.map((item) => item.id));
    const submittedValueRevision = valueRevisionRef.current;
    // The draft is deliberately retained on failure: a failed submit that also
    // erased what the user typed is the worst outcome available here.
    const reportFailure = (cause: unknown): void => {
      onErrorRef.current?.({
        code: "submit-failed",
        message: "The prompt could not be submitted.",
        cause,
      });
    };
    const leased = leasedIdsRef.current;
    for (const id of submittedIds) leased.set(id, (leased.get(id) ?? 0) + 1);
    /**
     * End this submission's borrow. A URL whose attachment was removed while
     * the handler ran is revoked now, once no other submission holds it.
     */
    const releaseLeases = (): void => {
      for (const id of submittedIds) {
        const holders = (leased.get(id) ?? 1) - 1;
        if (holders > 0) {
          leased.set(id, holders);
          continue;
        }
        leased.delete(id);
        if (attachmentsRef.current.some((item) => item.id === id)) continue;
        const objectUrl = objectUrlsRef.current.get(id);
        if (objectUrl === undefined) continue;
        if (canCreateObjectUrl()) URL.revokeObjectURL(objectUrl);
        objectUrlsRef.current.delete(id);
      }
    };
    let result: ReturnType<typeof onSubmit>;
    let thenable: boolean;
    try {
      result = onSubmit({ text: value, attachments: submitted }, event);
      thenable = typeof (result as PromiseLike<void> | undefined)?.then === "function";
    } catch (cause) {
      releaseLeases();
      reportFailure(cause);
      return;
    }

    /** Accept only the submitted draft, preserving edits made while pending. */
    const accept = (): void => {
      if (valueProp === undefined && valueRevisionRef.current === submittedValueRevision) {
        valueRevisionRef.current += 1;
        setInnerValue("");
      }
      if (attachmentsProp === undefined) {
        revokeObjectUrlsFor(submitted);
        const next = attachmentsRef.current.filter((item) => !submittedIds.has(item.id));
        attachmentsRef.current = next;
        setInnerAttachments(next);
      }
    };

    // A synchronous handler settles synchronously, which is what the
    // uncontrolled clear-on-submit behavior has always looked like. An async
    // handler holds the draft and its blob URLs until it resolves, because the
    // attachments it was handed are only readable while those URLs live.
    if (!thenable) {
      accept();
      releaseLeases();
      return;
    }
    // Promise.resolve adopts the thenable; a `then` getter or method that
    // throws becomes a rejection here, never an escaped exception.
    void Promise.resolve(result).then(
      () => {
        accept();
        releaseLeases();
      },
      (cause: unknown) => {
        releaseLeases();
        reportFailure(cause);
      },
    );
  };

  const contextValue = useMemo<PromptInputContextValue>(
    () => ({
      value,
      setValue,
      attachments,
      addFiles,
      removeAttachment,
      clearAttachments,
      openFileDialog,
      status,
      disabled,
      submitKey,
      onStop,
    }),
    [
      value,
      setValue,
      attachments,
      addFiles,
      removeAttachment,
      clearAttachments,
      openFileDialog,
      status,
      disabled,
      submitKey,
      onStop,
    ],
  );

  return (
    <PromptInputContext.Provider value={contextValue}>
      <form
        data-slot="prompt-input"
        data-status={status}
        data-disabled={disabled ? "true" : "false"}
        data-drop-active={dropActive ? "true" : "false"}
        className={cn("sui-prompt", className)}
        onSubmit={handleSubmit}
        onPaste={(event) => {
          onPaste?.(event);
          // Same escape hatch the drag handlers below honor: a consumer that
          // handled the paste itself is not overridden.
          if (event.defaultPrevented) return;
          const files = event.clipboardData?.files;
          if (files && files.length > 0) addFiles(files);
        }}
        onDragOver={(event) => {
          onDragOver?.(event);
          if (event.defaultPrevented) return;
          event.preventDefault();
          setDropActive(true);
        }}
        onDragLeave={(event) => {
          onDragLeave?.(event);
          if (!event.relatedTarget || !event.currentTarget.contains(event.relatedTarget as Node)) {
            setDropActive(false);
          }
        }}
        onDrop={(event) => {
          onDrop?.(event);
          if (event.defaultPrevented) return;
          event.preventDefault();
          setDropActive(false);
          const files = event.dataTransfer?.files;
          if (files && files.length > 0) addFiles(files);
        }}
        {...props}
      >
        {attachments.length > 0 ? (
          <AttachmentGroup data-slot="prompt-input-attachments" className="sui-prompt-attachments">
            {attachments.map((attachment) => (
              <Attachment
                key={attachment.id}
                name={attachment.name}
                state={attachment.state}
                sizeBytes={attachment.sizeBytes}
                mediaType={attachment.mediaType}
                thumbnailUrl={attachment.thumbnailUrl}
                progress={attachment.progress}
                onRemove={disabled ? undefined : () => removeAttachment(attachment.id)}
              />
            ))}
          </AttachmentGroup>
        ) : null}
        {children}
        <input
          ref={fileInputRef}
          type="file"
          className="sui-sr-only"
          tabIndex={-1}
          aria-hidden="true"
          accept={accept}
          multiple={multiple}
          disabled={disabled}
          onChange={(event) => {
            const files = event.currentTarget.files;
            if (files && files.length > 0) addFiles(files);
            event.currentTarget.value = "";
          }}
        />
        <div aria-live="polite" className="sui-sr-only">
          {announcement}
        </div>
      </form>
    </PromptInputContext.Provider>
  );
}

export function PromptInputHeader({ className, ...props }: ComponentProps<"div">) {
  useInjectUiCss();
  return <div data-slot="prompt-input-header" className={cn("sui-prompt-header", className)} {...props} />;
}

export function PromptInputBody({ className, ...props }: ComponentProps<"div">) {
  useInjectUiCss();
  return <div data-slot="prompt-input-body" className={cn("sui-prompt-body", className)} {...props} />;
}

export type PromptInputTextareaProps = Omit<ComponentProps<"textarea">, "value" | "onChange"> & {
  maxRows?: number;
};

export function PromptInputTextarea({
  maxRows = 8,
  className,
  onKeyDown,
  "aria-label": ariaLabel,
  rows: _rows,
  ...props
}: PromptInputTextareaProps) {
  useInjectUiCss();
  const { value, setValue, status, disabled, submitKey, onStop } = usePromptInputContext();
  const lineCount = value.split("\n").length;
  const rows = Math.max(1, Math.min(maxRows, lineCount));

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    onKeyDown?.(event);
    if (event.defaultPrevented || event.nativeEvent.isComposing) return;
    if (event.key === "Escape" && (status === "submitted" || status === "streaming") && onStop) {
      onStop();
      return;
    }
    if (event.key !== "Enter") return;
    if (submitKey === "enter") {
      if (!event.shiftKey) {
        event.preventDefault();
        event.currentTarget.form?.requestSubmit();
      }
    } else if (event.metaKey || event.ctrlKey) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  };

  return (
    <textarea
      data-slot="prompt-input-textarea"
      className={cn("sui-prompt-textarea", className)}
      aria-label={ariaLabel ?? "Message"}
      rows={rows}
      value={value}
      disabled={disabled}
      onChange={(event) => setValue(event.currentTarget.value)}
      onKeyDown={handleKeyDown}
      {...props}
    />
  );
}

export function PromptInputFooter({ className, ...props }: ComponentProps<"div">) {
  useInjectUiCss();
  return <div data-slot="prompt-input-footer" className={cn("sui-prompt-footer", className)} {...props} />;
}

export function PromptInputTools({ className, ...props }: ComponentProps<"div">) {
  useInjectUiCss();
  return <div data-slot="prompt-input-tools" className={cn("sui-prompt-tools", className)} {...props} />;
}

export function PromptInputButton({ className, type = "button", ...props }: ComponentProps<"button">) {
  useInjectUiCss();
  return (
    <button type={type} data-slot="prompt-input-button" className={cn("sui-prompt-button", className)} {...props} />
  );
}

export function PromptInputSubmit({ className, ...props }: ComponentProps<"button">) {
  useInjectUiCss();
  const { value, attachments, status, disabled } = usePromptInputContext();
  const busy = status === "submitted" || status === "streaming";
  const canSubmit = !disabled && !busy && (value.trim().length > 0 || attachments.length > 0);
  return (
    <button
      type="submit"
      data-slot="prompt-input-submit"
      data-status={status}
      className={cn("sui-prompt-submit", className)}
      aria-label="Send message"
      title="Send message"
      disabled={!canSubmit}
      {...props}
    >
      {status === "submitted" ? <Spinner size="sm" aria-label="Sending" /> : <span aria-hidden="true">↑</span>}
    </button>
  );
}

export function PromptInputStop({ className, onClick, ...props }: ComponentProps<"button">) {
  useInjectUiCss();
  const { status, onStop } = usePromptInputContext();
  if (!onStop || (status !== "submitted" && status !== "streaming")) return null;
  return (
    <button
      type="button"
      data-slot="prompt-input-stop"
      className={cn("sui-prompt-stop", className)}
      aria-label="Stop generating"
      title="Stop generating"
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented) onStop();
      }}
      {...props}
    >
      <span aria-hidden="true">■</span>
    </button>
  );
}

/* -------------------------------------------------------------------------- */
/* Action menu                                                                 */
/* -------------------------------------------------------------------------- */

type PromptInputMenuContextValue = {
  open: boolean;
  setOpen: (open: boolean) => void;
  triggerId: string;
  contentId: string;
  triggerRef: RefObject<HTMLButtonElement | null>;
  rootRef: RefObject<HTMLDivElement | null>;
};

const PromptInputMenuContext = createContext<PromptInputMenuContextValue | null>(null);

export type PromptInputActionMenuProps = ComponentProps<"div"> & {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
};

export function PromptInputActionMenu({
  open: openProp,
  defaultOpen = false,
  onOpenChange,
  className,
  children,
  ...props
}: PromptInputActionMenuProps) {
  useInjectUiCss();
  const [innerOpen, setInnerOpen] = useState(defaultOpen);
  const open = openProp !== undefined ? openProp : innerOpen;
  const baseId = useId();
  const triggerId = `${baseId}-trigger`;
  const contentId = `${baseId}-content`;
  const triggerRef = useRef<HTMLButtonElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const setOpen = useCallback(
    (next: boolean) => {
      if (openProp === undefined) setInnerOpen(next);
      onOpenChange?.(next);
    },
    [openProp, onOpenChange],
  );

  useEffect(() => {
    if (!open || typeof document === "undefined") return;
    const onPointerDown = (event: MouseEvent) => {
      const root = rootRef.current;
      if (root && event.target instanceof Node && !root.contains(event.target)) setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open, setOpen]);

  const contextValue = useMemo<PromptInputMenuContextValue>(
    () => ({ open, setOpen, triggerId, contentId, triggerRef, rootRef }),
    [open, setOpen, triggerId, contentId],
  );

  return (
    <PromptInputMenuContext.Provider value={contextValue}>
      <div
        ref={rootRef}
        data-slot="prompt-input-action-menu"
        className={cn("sui-prompt-action-menu", className)}
        {...props}
      >
        {children}
      </div>
    </PromptInputMenuContext.Provider>
  );
}

export function PromptInputActionMenuTrigger({
  className,
  children,
  onClick,
  onKeyDown,
  "aria-label": ariaLabel,
  ...props
}: ComponentProps<"button">) {
  useInjectUiCss();
  const menu = useContext(PromptInputMenuContext);
  if (!menu) throw new Error("PromptInputActionMenuTrigger must be used within a PromptInputActionMenu");
  return (
    <button
      ref={menu.triggerRef}
      type="button"
      id={menu.triggerId}
      data-slot="prompt-input-action-menu-trigger"
      className={cn("sui-prompt-button", className)}
      aria-haspopup="menu"
      aria-expanded={menu.open}
      aria-controls={menu.contentId}
      aria-label={ariaLabel ?? "Open action menu"}
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented) menu.setOpen(!menu.open);
      }}
      onKeyDown={(event) => {
        onKeyDown?.(event);
        if (event.defaultPrevented) return;
        if (event.key === "Enter" || event.key === " " || event.key === "ArrowDown") {
          event.preventDefault();
          menu.setOpen(true);
        }
      }}
      {...props}
    >
      {children ?? <span aria-hidden="true">+</span>}
    </button>
  );
}

function isMarkedMenuItem(child: ReactNode): boolean {
  if (!isValidElement(child)) return false;
  if ((child.props as { "data-slot"?: string })["data-slot"] === "prompt-input-action-menu-item") {
    return true;
  }
  return (child.type as { promptInputMenuItem?: boolean }).promptInputMenuItem === true;
}

export function PromptInputActionMenuContent({ className, children, onKeyDown, ...props }: ComponentProps<"div">) {
  useInjectUiCss();
  const menu = useContext(PromptInputMenuContext);
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menu?.open) return;
    const first = contentRef.current?.querySelector<HTMLElement>('[role="menuitem"]');
    first?.focus();
  }, [menu?.open]);

  if (!menu) throw new Error("PromptInputActionMenuContent must be used within a PromptInputActionMenu");
  if (!menu.open) return null;

  const focusItem = (direction: 1 | -1) => {
    const items = Array.from(contentRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
    if (items.length === 0) return;
    const activeIndex = items.indexOf(document.activeElement as HTMLElement);
    const nextIndex = activeIndex < 0 ? 0 : (activeIndex + direction + items.length) % items.length;
    items[nextIndex]?.focus();
  };

  const wrapped = Children.map(children, (child, index) => {
    if (isMarkedMenuItem(child)) return child;
    return (
      <div
        key={index}
        role="menuitem"
        tabIndex={-1}
        data-slot="prompt-input-action-menu-item"
        className="sui-prompt-action-menu-item"
        onClick={(event) => {
          if (!event.defaultPrevented) menu.setOpen(false);
        }}
      >
        {child}
      </div>
    );
  });

  return (
    <div
      ref={contentRef}
      id={menu.contentId}
      role="menu"
      aria-labelledby={menu.triggerId}
      data-slot="prompt-input-action-menu-content"
      className={cn("sui-prompt-action-menu-content", className)}
      onKeyDown={(event) => {
        onKeyDown?.(event);
        if (event.defaultPrevented) return;
        if (event.key === "ArrowDown") {
          event.preventDefault();
          focusItem(1);
        } else if (event.key === "ArrowUp") {
          event.preventDefault();
          focusItem(-1);
        } else if (event.key === "Escape") {
          event.preventDefault();
          menu.setOpen(false);
          menu.triggerRef.current?.focus();
        }
      }}
      {...props}
    >
      {wrapped}
    </div>
  );
}

export function PromptInputActionAddAttachments({ className, children, onClick, ...props }: ComponentProps<"button">) {
  useInjectUiCss();
  const input = usePromptInputContext();
  const menu = useContext(PromptInputMenuContext);
  return (
    <button
      type="button"
      role="menuitem"
      data-slot="prompt-input-action-menu-item"
      className={cn("sui-prompt-action-menu-item", className)}
      onClick={(event) => {
        onClick?.(event);
        if (event.defaultPrevented) return;
        input.openFileDialog();
        menu?.setOpen(false);
      }}
      {...props}
    >
      {children ?? "Add attachments"}
    </button>
  );
}

(PromptInputActionAddAttachments as { promptInputMenuItem?: boolean }).promptInputMenuItem = true;
