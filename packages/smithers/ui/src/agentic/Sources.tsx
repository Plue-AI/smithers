/** @jsxImportSource react */
import {
  createContext,
  useContext,
  useId,
  useState,
  type ComponentProps,
  type MouseEvent,
  type ReactNode,
} from "react";
import { cn } from "../cn";
import { useInjectUiCss } from "../styles";
import { safeHref } from "../internal/safeHref";
import { safeImageSrc } from "../internal/safeImageSrc";

export type SourceItem = { id: string; label: string; href?: string };

export type SourcesProps = Omit<ComponentProps<"div">, "children"> & {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
} & (
    | {
        sources: readonly SourceItem[];
        onNavigate?: (href: string, event: MouseEvent<HTMLAnchorElement>) => void;
        children?: never;
      }
    | { children: ReactNode; sources?: never }
  );

type SourcesContextValue = {
  open: boolean;
  toggle: () => void;
  triggerId: string;
  contentId: string;
};

const SourcesContext = createContext<SourcesContextValue | null>(null);

/** Text-only, collapsible attribution list for response sources. */
export function Sources(props: SourcesProps) {
  useInjectUiCss();
  const { open: controlledOpen, defaultOpen = false, onOpenChange, className } = props;
  const triggerId = useId();
  const contentId = useId();
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  const isControlled = controlledOpen !== undefined;
  const open = isControlled ? controlledOpen : uncontrolledOpen;

  function toggle() {
    const next = !open;
    if (!isControlled) setUncontrolledOpen(next);
    onOpenChange?.(next);
  }

  if ("sources" in props && props.sources !== undefined) {
    const { sources, onNavigate } = props;
    const rest = { ...props } as Record<string, unknown>;
    delete rest.sources;
    delete rest.onNavigate;
    delete rest.children;
    delete rest.open;
    delete rest.defaultOpen;
    delete rest.onOpenChange;
    delete rest.className;

    const countLabel = `Used ${sources.length} ${sources.length === 1 ? "source" : "sources"}`;

    return (
      <div data-slot="sources" data-state={open ? "open" : "closed"} className={cn("sui-sources", className)} {...rest}>
        <button
          type="button"
          data-slot="sources-trigger"
          className="sui-sources-trigger"
          aria-expanded={open}
          aria-controls={contentId}
          onClick={toggle}
        >
          {countLabel}
        </button>
        {open ? (
          <ul data-slot="sources-list" id={contentId} className="sui-sources-list">
            {sources.map((source) => {
              const href = source.href === undefined ? undefined : safeHref(source.href);
              return (
                <li data-slot="sources-item" className="sui-sources-item" key={source.id}>
                  {href !== undefined ? (
                    <a
                      className="sui-sources-link"
                      href={href}
                      onClick={
                        onNavigate
                          ? (event) => {
                              event.preventDefault();
                              onNavigate(href, event);
                            }
                          : undefined
                      }
                    >
                      {source.label}
                    </a>
                  ) : (
                    <span className="sui-sources-label">{source.label}</span>
                  )}
                </li>
              );
            })}
          </ul>
        ) : null}
      </div>
    );
  }

  const { children } = props;
  const rest = { ...props } as Record<string, unknown>;
  delete rest.children;
  delete rest.sources;
  delete rest.open;
  delete rest.defaultOpen;
  delete rest.onOpenChange;
  delete rest.className;

  return (
    <SourcesContext.Provider value={{ open, toggle, triggerId, contentId }}>
      <div data-slot="sources" data-state={open ? "open" : "closed"} className={cn("sui-sources", className)} {...rest}>
        {children}
      </div>
    </SourcesContext.Provider>
  );
}

export type SourcesTriggerProps = Omit<ComponentProps<"button">, "children"> & {
  count?: number;
  children?: ReactNode;
};

/** Disclosure trigger for a compound Sources; defaults to a 'Used N sources' label. */
export function SourcesTrigger({ count, children, className, onClick, type, ...props }: SourcesTriggerProps) {
  useInjectUiCss();
  const context = useContext(SourcesContext);
  const label = children ?? (count === undefined ? "Sources" : `Used ${count} ${count === 1 ? "source" : "sources"}`);

  return (
    <button
      type={type ?? "button"}
      data-slot="sources-trigger"
      id={context?.triggerId}
      className={cn("sui-sources-trigger", className)}
      aria-expanded={context?.open}
      aria-controls={context?.contentId}
      onClick={(event) => {
        context?.toggle();
        onClick?.(event);
      }}
      {...props}
    >
      {label}
    </button>
  );
}

export type SourcesContentProps = ComponentProps<"ul">;

/** Collapsible source list region for a compound Sources; renders a <ul>. */
export function SourcesContent({ className, children, role, ...props }: SourcesContentProps) {
  useInjectUiCss();
  const context = useContext(SourcesContext);
  if (context && !context.open) return null;

  return (
    <ul
      data-slot="sources-content"
      id={context?.contentId}
      role={role ?? "region"}
      aria-labelledby={context?.triggerId}
      className={cn("sui-sources-content", className)}
      {...props}
    >
      {children}
    </ul>
  );
}

export type SourceProps = Omit<ComponentProps<"a">, "title" | "href" | "children" | "onClick"> & {
  href?: string;
  title: ReactNode;
  domain?: string;
  excerpt?: ReactNode;
  faviconUrl?: string;
  onNavigate?: (href: string, event: MouseEvent<HTMLAnchorElement>) => void;
  children?: ReactNode;
};

/** One rich source row: favicon (or domain-initial fallback), title, domain, excerpt. */
export function Source({
  href: rawHref,
  title,
  domain,
  excerpt,
  faviconUrl,
  onNavigate,
  children,
  className,
  ...props
}: SourceProps) {
  useInjectUiCss();
  const href = rawHref === undefined ? undefined : safeHref(rawHref);
  const initial =
    (domain ?? "").trim().charAt(0).toUpperCase() ||
    (typeof title === "string" ? title.trim().charAt(0).toUpperCase() : "") ||
    "?";

  const faviconSrc = faviconUrl === undefined ? undefined : safeImageSrc(faviconUrl);
  const favicon =
    faviconSrc !== undefined ? (
      <img className="sui-sources-favicon" src={faviconSrc} alt="" width={16} height={16} />
    ) : (
      <span className="sui-sources-favicon-fallback" aria-hidden="true">
        {initial}
      </span>
    );

  const body = (
    <>
      {favicon}
      <span className="sui-sources-body">
        <span className="sui-sources-title">{title}</span>
        {domain !== undefined ? <span className="sui-sources-domain">{domain}</span> : null}
        {excerpt !== undefined ? <span className="sui-sources-excerpt">{excerpt}</span> : null}
        {children}
      </span>
    </>
  );

  return (
    <li data-slot="source" className="sui-sources-item">
      {href !== undefined ? (
        <a
          {...props}
          className={cn("sui-sources-link", "sui-sources-rich", className)}
          href={href}
          onClick={
            onNavigate
              ? (event) => {
                  event.preventDefault();
                  onNavigate(href, event);
                }
              : undefined
          }
        >
          {body}
        </a>
      ) : (
        <span {...(props as ComponentProps<"span">)} className={cn("sui-sources-label", "sui-sources-rich", className)}>
          {body}
        </span>
      )}
    </li>
  );
}
