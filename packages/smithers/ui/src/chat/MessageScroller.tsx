/** @jsxImportSource react */
import {
  type ComponentProps,
  createContext,
  type CSSProperties,
  forwardRef,
  type ForwardRefExoticComponent,
  type ReactNode,
  type RefAttributes,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { cn } from "../cn";
import { decideTranscriptScroll } from "./transcriptScroll";
import { prefersReducedMotion, useInjectUiCss } from "../styles";
import { subscribeVisibility } from "./visibilitySubscriptionRegistry";

/* -------------------------------------------------------------------------- */
/* Frozen public types                                                        */
/* -------------------------------------------------------------------------- */

export type MessageScrollerCommands = {
  scrollToBottom(behavior?: ScrollBehavior): void;
  scrollToTop(behavior?: ScrollBehavior): void;
  /** Jump so the message's top sits `peekPx` below the viewport top. */
  scrollToMessage(messageId: string, opts?: { behavior?: ScrollBehavior; peek?: boolean; }): boolean;
};

export type MessageScrollerProviderProps = {
  /** 'bottom' pins and follows growth; 'none' (upstream default) never autoscrolls. */
  scrollAnchor?: "bottom" | "none";
  /** Saved-transcript restore: anchor this registered message on mount. */
  initialMessageId?: string;
  /** Read new output from its top when oversized; otherwise follow its bottom. */
  readAnchor?: { messageId: string; actor?: "arrival" | "user" | "output"; userMessageId?: string; requestId?: number; version?: string | number };
  bottomThreshold?: number;
  /** Previous-item peek (px) applied on jump/restore. */
  peekPx?: number;
  onFollowChange?: (following: boolean) => void;
  children: ReactNode;
};

export type MessageScrollerViewportProps = Omit<ComponentProps<"div">, "onScroll"> & {
  /** Edge fade masks driven by scroll position. */
  fade?: boolean;
};

export type MessageScrollerContentProps = ComponentProps<"div">;

export type MessageScrollerItemProps = ComponentProps<"div"> & {
  /** Stable message identity used by jump/restore/visibility. */
  messageId: string;
  /** Placeholder height hint for content-visibility (default 96). */
  intrinsicSize?: number;
  /**
   * Marks this row as the start of a turn. When a new anchored row is
   * appended, the viewport moves it near the top with a previous-item peek
   * and holds while the reply streams into the room below; once the reply
   * fills the viewport, follow-output takes over again.
   */
  scrollAnchor?: boolean;
};

export type MessageScrollerButtonProps = Omit<ComponentProps<"button">, "onClick"> & {
  target?: "latest" | "start" | { messageId: string; };
  behavior?: ScrollBehavior;
};

/* -------------------------------------------------------------------------- */
/* Provider internals                                                         */
/* -------------------------------------------------------------------------- */

type ScrollSnapshot = {
  firstItemKey: string | number | undefined;
  scrollHeight: number;
  scrollTop: number;
};

type ViewportState = { atTop: boolean; atBottom: boolean; following: boolean; autoscrolling: boolean; };

type ScrollerContextValue = {
  commands: MessageScrollerCommands;
  isFollowing: () => boolean;
  isReading: () => boolean;
  registerViewport: (el: HTMLDivElement | null) => void;
  handleViewportScroll: () => void;
  registerItem: (messageId: string, el: HTMLElement | null, scrollAnchor?: boolean) => void;
  subscribeState: (listener: () => void) => () => void;
  getState: () => ViewportState;
  subscribeVisibility: (messageId: string, listener: () => void) => () => void;
  isMessageVisible: (messageId: string) => boolean;
};

const ScrollerContext = createContext<ScrollerContextValue | null>(null);

function useScrollerContext(part: string): ScrollerContextValue {
  const ctx = useContext(ScrollerContext);
  if (!ctx) throw new Error(`${part} must be used inside <MessageScrollerProvider>`);
  return ctx;
}

function useScrollerLaneCss(): void {
  useInjectUiCss();
}

const SCROLL_KEYS = new Set(["PageUp", "PageDown", "Home", "End", "ArrowUp", "ArrowDown"]);

function MessageScrollerProviderImpl({
  scrollAnchor = "none",
  initialMessageId,
  readAnchor,
  bottomThreshold = 24,
  peekPx = 56,
  onFollowChange,
  children,
}: MessageScrollerProviderProps) {
  const readAnchorRef = useRef(readAnchor);
  readAnchorRef.current = readAnchor;
  const readKey = readAnchor ? `${readAnchor.messageId}:${readAnchor.version ?? ""}` : undefined;
  const previousReadKeyRef = useRef(readKey);
  const previousUserMessageRef = useRef(readAnchor?.userMessageId);
  const previousRequestIdRef = useRef(readAnchor?.requestId);
  const activeReadRef = useRef<{ id: string; arrival: boolean } | null>(null);
  const userReadPendingRef = useRef(false);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [viewportElement, setViewportElement] = useState<HTMLDivElement | null>(null);
  const itemsRef = useRef(new Map<string, HTMLElement>());
  const anchorFlagsRef = useRef(new Map<string, boolean>());
  const mountedRef = useRef(false);
  const anchoringRef = useRef(scrollAnchor === "bottom");
  const followingRef = useRef(scrollAnchor === "bottom");
  const ignoreScrollUntilBottomRef = useRef(false);
  const restorePendingRef = useRef(initialMessageId !== undefined);
  const turnAnchorRef = useRef<{ id: string; top: number; } | null>(null);
  const pendingAnchorIdRef = useRef<string | null>(null);
  const ignoreNextScrollRef = useRef(false);
  const queuedJumpRef = useRef<{ messageId: string; opts?: { behavior?: ScrollBehavior; peek?: boolean; }; } | null>(
    null,
  );
  const snapshotRef = useRef<ScrollSnapshot>({ firstItemKey: undefined, scrollHeight: 0, scrollTop: 0 });
  const previousAnchorRef = useRef(scrollAnchor);
  const onFollowChangeRef = useRef(onFollowChange);
  const thresholdRef = useRef(bottomThreshold);
  const peekPxRef = useRef(peekPx);
  const stateRef = useRef<ViewportState>({
    atTop: true,
    atBottom: true,
    following: scrollAnchor === "bottom",
    autoscrolling: false,
  });
  const stateListenersRef = useRef(new Set<() => void>());
  const visibleRef = useRef(new Set<string>());
  const visibilityListenersRef = useRef(new Map<string, Set<() => void>>());
  const observerRef = useRef<IntersectionObserver | null>(null);

  anchoringRef.current = scrollAnchor === "bottom";
  onFollowChangeRef.current = onFollowChange;
  thresholdRef.current = bottomThreshold;
  peekPxRef.current = peekPx;

  const emitState = useCallback((patch: Partial<ViewportState>) => {
    const next = { ...stateRef.current, ...patch };
    if (
      next.atTop === stateRef.current.atTop &&
      next.atBottom === stateRef.current.atBottom &&
      next.following === stateRef.current.following &&
      next.autoscrolling === stateRef.current.autoscrolling
    ) {
      return;
    }
    stateRef.current = next;
    for (const listener of stateListenersRef.current) listener();
  }, []);

  /**
   * Tracks a programmatic jump-to-latest: while on, mid-flight scroll events
   * cannot strand follow and the root/viewport expose data-autoscrolling.
   */
  const setJumpTracking = useCallback(
    (on: boolean) => {
      if (ignoreScrollUntilBottomRef.current === on) return;
      ignoreScrollUntilBottomRef.current = on;
      emitState({ autoscrolling: on });
    },
    [emitState],
  );

  const measure = useCallback(
    (viewport: HTMLDivElement) => {
      const bottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= thresholdRef.current;
      emitState({ atBottom: bottom, atTop: viewport.scrollTop <= 0 });
      return bottom;
    },
    [emitState],
  );

  const setFollowing = useCallback(
    (next: boolean, notify = true) => {
      const resolved = anchoringRef.current ? next : false;
      if (followingRef.current === resolved) return;
      followingRef.current = resolved;
      emitState({ following: resolved });
      if (notify && mountedRef.current) {
        onFollowChangeRef.current?.(resolved);
      }
    },
    [emitState],
  );

  const firstDomItemId = useCallback((): string | undefined => {
    const viewport = viewportRef.current;
    const first = viewport?.querySelector<HTMLElement>("[data-message-id]");
    return first?.dataset.messageId;
  }, []);

  const remember = useCallback(
    (viewport: HTMLDivElement) => {
      snapshotRef.current = {
        firstItemKey: firstDomItemId(),
        scrollHeight: viewport.scrollHeight,
        scrollTop: viewport.scrollTop,
      };
    },
    [firstDomItemId],
  );

  const resolveBehavior = useCallback((behavior: ScrollBehavior): ScrollBehavior => {
    return behavior === "smooth" && prefersReducedMotion() ? "auto" : behavior;
  }, []);

  const scrollViewportTo = useCallback(
    (top: number, behavior: ScrollBehavior) => {
      const viewport = viewportRef.current;
      if (!viewport) return;
      const resolved = resolveBehavior(behavior);
      if (resolved === "auto") {
        viewport.scrollTop = top;
      } else if (typeof viewport.scrollTo === "function") {
        viewport.scrollTo({ top, behavior: resolved });
      } else {
        viewport.scrollTop = top;
      }
    },
    [resolveBehavior],
  );

  /**
   * Item top in scroll-content coordinates. Rect math is positioning
   * independent: the viewport is statically positioned, so it is NOT the
   * item's offsetParent and an offsetTop walk would leak page-level offsets.
   */
  const itemTopWithinViewport = useCallback((el: HTMLElement): number => {
    const viewport = viewportRef.current;
    if (!viewport) return 0;
    return el.getBoundingClientRect().top - viewport.getBoundingClientRect().top + viewport.scrollTop;
  }, []);

  /* ---- visibility tracking ----------------------------------------------- */

  const setMessageVisible = useCallback((messageId: string, visible: boolean) => {
    const set = visibleRef.current;
    const has = set.has(messageId);
    if (has === visible) return;
    if (visible) set.add(messageId);
    else set.delete(messageId);
    const listeners = visibilityListenersRef.current.get(messageId);
    if (listeners) { for (const listener of listeners) listener(); }
  }, []);

  const recomputeVisibilityGeometric = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const viewTop = viewport.scrollTop;
    const viewBottom = viewTop + viewport.clientHeight;
    for (const [id, el] of itemsRef.current) {
      const top = itemTopWithinViewport(el);
      const height = el.offsetHeight;
      const bottom = top + height;
      const overlap = Math.min(bottom, viewBottom) - Math.max(top, viewTop);
      const fillsViewport = top <= viewTop && bottom >= viewBottom && height >= viewport.clientHeight;
      const visible = fillsViewport || (height > 0 && overlap >= height * 0.5);
      setMessageVisible(id, visible);
    }
  }, [itemTopWithinViewport, setMessageVisible]);

  /** Geometric fallback must refresh after programmatic jumps (no scroll event). */
  const refreshVisibilityFallback = useCallback(() => {
    if (typeof IntersectionObserver === "undefined") recomputeVisibilityGeometric();
  }, [recomputeVisibilityGeometric]);

  const maxScrollTop = useCallback((viewport: HTMLDivElement): number => {
    return Math.max(viewport.scrollHeight - viewport.clientHeight, 0);
  }, []);

  const scrollToBottom = useCallback(
    (behavior: ScrollBehavior = "auto") => {
      const viewport = viewportRef.current;
      if (!viewport) return;
      restorePendingRef.current = false;
      queuedJumpRef.current = null;
      turnAnchorRef.current = null;
      activeReadRef.current = readAnchorRef.current ? { id: readAnchorRef.current.messageId, arrival: false } : null;
      setJumpTracking(anchoringRef.current);
      scrollViewportTo(viewport.scrollHeight, behavior);
      const bottom = measure(viewport);
      remember(viewport);
      refreshVisibilityFallback();
      if (bottom && anchoringRef.current) {
        setJumpTracking(false);
        setFollowing(true);
      }
    },
    [measure, remember, refreshVisibilityFallback, scrollViewportTo, setFollowing, setJumpTracking],
  );

  const scrollToTop = useCallback(
    (behavior: ScrollBehavior = "auto") => {
      const viewport = viewportRef.current;
      if (!viewport) return;
      restorePendingRef.current = false;
      queuedJumpRef.current = null;
      turnAnchorRef.current = null;
      setJumpTracking(false);
      scrollViewportTo(0, behavior);
      measure(viewport);
      remember(viewport);
      refreshVisibilityFallback();
      // Follow survives only when the whole transcript fits the viewport.
      if (anchoringRef.current) setFollowing(maxScrollTop(viewport) <= thresholdRef.current);
    },
    [maxScrollTop, measure, remember, refreshVisibilityFallback, scrollViewportTo, setFollowing, setJumpTracking],
  );

  const scrollToMessage = useCallback(
    (messageId: string, opts?: { behavior?: ScrollBehavior; peek?: boolean; }): boolean => {
      const viewport = viewportRef.current;
      const el = itemsRef.current.get(messageId);
      if (!viewport) return false;
      if (!el) {
        // Permalink resolution can race the transcript mount: queue the jump
        // while no rows exist yet. Once rows have mounted a missing id is a
        // real miss and reports false instead of starting a guessed retry.
        if (itemsRef.current.size === 0) {
          queuedJumpRef.current = { messageId, opts };
          return true;
        }
        return false;
      }
      restorePendingRef.current = false;
      queuedJumpRef.current = null;
      turnAnchorRef.current = null;
      const peek = opts?.peek ?? true;
      const maxTop = maxScrollTop(viewport);
      const top = Math.min(Math.max(itemTopWithinViewport(el) - (peek ? peekPxRef.current : 0), 0), maxTop);
      // A jump whose target clamps to the bottom region IS a jump-to-latest:
      // track it like scrollToBottom so mid-flight scroll events cannot strand
      // follow and streaming growth re-targets the moving bottom until landing.
      const targetsBottom = anchoringRef.current && maxTop - top <= thresholdRef.current;
      setJumpTracking(targetsBottom);
      scrollViewportTo(top, opts?.behavior ?? "auto");
      const bottom = measure(viewport);
      remember(viewport);
      refreshVisibilityFallback();
      if (anchoringRef.current) {
        if (targetsBottom) {
          // Derive follow from the deterministic target, not the pre-scroll
          // position: a smooth scroll has not settled yet when this runs, so
          // only a landed jump engages follow here; an in-flight one is
          // reconciled by the tracked scroll/resize/scrollend paths.
          if (bottom) {
            setJumpTracking(false);
            setFollowing(true);
          }
        } else {
          setFollowing(false);
        }
      }
      return true;
    },
    [
      itemTopWithinViewport,
      maxScrollTop,
      measure,
      remember,
      refreshVisibilityFallback,
      scrollViewportTo,
      setFollowing,
      setJumpTracking,
    ],
  );

  const commandsRef = useRef<MessageScrollerCommands>({ scrollToBottom, scrollToTop, scrollToMessage });
  commandsRef.current = { scrollToBottom, scrollToTop, scrollToMessage };

  /* ---- saved-transcript restore ------------------------------------------ */

  const tryRestore = useCallback(() => {
    if (!restorePendingRef.current || initialMessageId === undefined) return;
    const viewport = viewportRef.current;
    const el = itemsRef.current.get(initialMessageId);
    if (!viewport || !el) return;
    restorePendingRef.current = false;
    setJumpTracking(false);
    if (readAnchorRef.current) {
      activeReadRef.current = { id: initialMessageId, arrival: true };
      const decision = decideTranscriptScroll({ following: true }, viewport,
        { top: itemTopWithinViewport(el), height: el.getBoundingClientRect().height }, "arrival");
      viewport.scrollTop = decision.top!;
      setFollowing(true);
    } else {
      viewport.scrollTop = Math.max(itemTopWithinViewport(el) - peekPxRef.current, 0);
      // A restored position is a deliberate mid-transcript anchor: stop following.
      setFollowing(false);
    }
    measure(viewport);
    remember(viewport);
    refreshVisibilityFallback();
  }, [
    initialMessageId,
    itemTopWithinViewport,
    measure,
    remember,
    refreshVisibilityFallback,
    setFollowing,
    setJumpTracking,
  ]);

  // Invoked after a DOM commit and by ResizeObserver; no timer guesses about
  // streaming, card hydration, or the composer changing the viewport height.
  const maintainRead = useCallback(() => {
    const viewport = viewportRef.current;
    const request = readAnchorRef.current;
    if (!viewport || !request) return;
    const key = `${request.messageId}:${request.version ?? ""}`;
    if (previousRequestIdRef.current !== request.requestId) userReadPendingRef.current = true;
    previousRequestIdRef.current = request.requestId;
    const sent = request.userMessageId !== previousUserMessageRef.current;
    previousUserMessageRef.current = request.userMessageId;
    const changed = previousReadKeyRef.current !== key || sent;
    previousReadKeyRef.current = key;
    let actor: "arrival" | "user" | "output" = "output";
    if (changed) {
      actor = sent || userReadPendingRef.current ? "user" : request.actor ?? "output";
      userReadPendingRef.current = false;
      // Arrival starts armed on mount. A later Home response must not undo a
      // scroll-up the reader made while Welcome was loading.
      if (actor === "arrival" && !followingRef.current) actor = "output";
      activeReadRef.current = { id: request.messageId, arrival: actor === "arrival" || (restorePendingRef.current && request.messageId === initialMessageId) };
      restorePendingRef.current = false;
    }
    if (restorePendingRef.current) tryRestore();
    if (restorePendingRef.current) return;
    const read = activeReadRef.current ?? { id: request.messageId, arrival: false };
    activeReadRef.current = read;
    if (actor === "user") setFollowing(true);
    const el = itemsRef.current.get(read.id);
    if (!el) return;
    if (read.arrival && followingRef.current) actor = "arrival";
    const decision = decideTranscriptScroll({ following: followingRef.current }, viewport,
      { top: itemTopWithinViewport(el), height: el.getBoundingClientRect().height }, actor);
    if (decision.top !== null) viewport.scrollTop = decision.top;
    setFollowing(decision.following);
    measure(viewport);
    remember(viewport);
    refreshVisibilityFallback();
  }, [initialMessageId, itemTopWithinViewport, measure, remember, refreshVisibilityFallback, setFollowing, tryRestore]);

  const requestUserRead = useCallback((event: MouseEvent) => {
    if (readAnchorRef.current && event.target instanceof Element && event.target.closest("button[data-flow]")) {
      userReadPendingRef.current = true;
    }
  }, []);

  /**
   * Turn anchoring: a newly appended scrollAnchor row moves near the top with
   * a previous-item peek. When the target clamps into the bottom region the
   * append is just the live edge, so it tracks like jump-to-latest instead.
   * Otherwise follow releases and the position holds while the reply streams
   * into the room below; growth past the viewport re-engages follow.
   */
  const anchorTurn = useCallback(
    (el: HTMLElement, messageId: string) => {
      const viewport = viewportRef.current;
      if (!viewport) return;
      const maxTop = maxScrollTop(viewport);
      const target = Math.max(itemTopWithinViewport(el) - peekPxRef.current, 0);
      const top = Math.min(target, maxTop);
      const targetsBottom = anchoringRef.current && maxTop - top <= thresholdRef.current;
      if (targetsBottom) {
        setJumpTracking(true);
        scrollViewportTo(viewport.scrollHeight, "auto");
        if (measure(viewport)) {
          setJumpTracking(false);
          setFollowing(true);
        }
      } else {
        // The anchor scroll fires a scroll event that must not read as a user
        // gesture: suppress exactly one, then hold the turn position.
        ignoreNextScrollRef.current = true;
        turnAnchorRef.current = { id: messageId, top: target };
        scrollViewportTo(top, "auto");
        if (anchoringRef.current) setFollowing(false);
        measure(viewport);
      }
      refreshVisibilityFallback();
    },
    [
      itemTopWithinViewport,
      maxScrollTop,
      measure,
      refreshVisibilityFallback,
      scrollViewportTo,
      setFollowing,
      setJumpTracking,
    ],
  );

  const observeItem = useCallback((messageId: string, el: HTMLElement | null) => {
    const observer = observerRef.current;
    if (!observer) return;
    if (el) observer.observe(el);
    else {
      const previous = itemsRef.current.get(messageId);
      if (previous) observer.unobserve(previous);
    }
  }, []);

  /* ---- registration ------------------------------------------------------- */

  const registerItem = useCallback(
    (messageId: string, el: HTMLElement | null, itemScrollAnchor?: boolean) => {
      if (el) {
        const isNew = !itemsRef.current.has(messageId);
        itemsRef.current.set(messageId, el);
        anchorFlagsRef.current.set(messageId, itemScrollAnchor === true);
        observeItem(messageId, el);
        tryRestore();
        // A queued permalink jump runs as soon as its row registers.
        if (queuedJumpRef.current?.messageId === messageId) {
          const queued = queuedJumpRef.current;
          queuedJumpRef.current = null;
          scrollToMessage(messageId, queued.opts);
        }
        // A new anchored row appended after mount anchors the next turn; the
        // per-commit layout effect performs the move once the DOM settles.
        if (isNew && mountedRef.current && itemScrollAnchor) {
          pendingAnchorIdRef.current = messageId;
        }
        if (typeof IntersectionObserver === "undefined") recomputeVisibilityGeometric();
      } else {
        observeItem(messageId, null);
        itemsRef.current.delete(messageId);
        anchorFlagsRef.current.delete(messageId);
        if (turnAnchorRef.current?.id === messageId) turnAnchorRef.current = null;
        if (pendingAnchorIdRef.current === messageId) pendingAnchorIdRef.current = null;
        setMessageVisible(messageId, false);
      }
    },
    [observeItem, recomputeVisibilityGeometric, scrollToMessage, setMessageVisible, tryRestore],
  );

  const cancelProgrammaticScroll = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    restorePendingRef.current = false;
    queuedJumpRef.current = null;
    turnAnchorRef.current = null;
    setJumpTracking(false);
    const bottom = measure(viewport);
    remember(viewport);
    if (anchoringRef.current) setFollowing(readAnchorRef.current ? false : bottom);
    userReadPendingRef.current = false;
    previousRequestIdRef.current = readAnchorRef.current?.requestId;
  }, [measure, remember, setFollowing, setJumpTracking]);

  // Downward input at the bottom cannot move the viewport, so no subsequent
  // scroll event will restore follow if we cancel it here.
  const isAtBottomBoundary = useCallback(() => {
    const viewport = viewportRef.current;
    return viewport !== null && viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop <= 1;
  }, []);

  const onViewportWheel = useCallback((event: WheelEvent) => {
    if (event.deltaY === 0 || (event.deltaY > 0 && isAtBottomBoundary())) return;
    cancelProgrammaticScroll();
  }, [cancelProgrammaticScroll, isAtBottomBoundary]);

  const onViewportKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (["ArrowDown", "PageDown", "End"].includes(event.key) && isAtBottomBoundary()) return;
      if (SCROLL_KEYS.has(event.key)) cancelProgrammaticScroll();
    },
    [cancelProgrammaticScroll, isAtBottomBoundary],
  );

  /**
   * scrollend reconciles a tracked jump wherever it settled. Without it a
   * scrollbar drag that stops short of the bottom leaves the jump tracked
   * forever, and the next content growth would hijack the reader's position.
   */
  const onViewportScrollEnd = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport || !ignoreScrollUntilBottomRef.current) return;
    setJumpTracking(false);
    const bottom = measure(viewport);
    remember(viewport);
    if (anchoringRef.current) setFollowing(bottom);
  }, [measure, remember, setFollowing, setJumpTracking]);

  const registerViewport = useCallback(
    (el: HTMLDivElement | null) => {
      const previous = viewportRef.current;
      if (previous && previous !== el) {
        previous.removeEventListener("click", requestUserRead, true);
        previous.removeEventListener("wheel", onViewportWheel);
        previous.removeEventListener("touchmove", cancelProgrammaticScroll);
        previous.removeEventListener("keydown", onViewportKeyDown);
        previous.removeEventListener("scrollend", onViewportScrollEnd);
      }
      viewportRef.current = el;
      setViewportElement(el);
      if (el) {
        el.addEventListener("click", requestUserRead, true);
        el.addEventListener("wheel", onViewportWheel, { passive: true });
        el.addEventListener("touchmove", cancelProgrammaticScroll, { passive: true });
        el.addEventListener("keydown", onViewportKeyDown);
        el.addEventListener("scrollend", onViewportScrollEnd);
      }
    },
    [cancelProgrammaticScroll, onViewportWheel, onViewportKeyDown, onViewportScrollEnd, requestUserRead],
  );

  const handleScroll = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    // The turn-anchor scroll is programmatic: swallow its single event so it
    // is not read as a reader gesture that cancels the anchor.
    if (ignoreNextScrollRef.current) {
      ignoreNextScrollRef.current = false;
      measure(viewport);
      remember(viewport);
      if (typeof IntersectionObserver === "undefined") recomputeVisibilityGeometric();
      return;
    }
    const previousTop = snapshotRef.current.scrollTop;
    const bottom = measure(viewport);
    // A scroll that leaves the anchor pin while a restore is pending is a user
    // gesture (scrollbar drags surface only as scroll events): cancel retrying.
    if (restorePendingRef.current && !bottom) restorePendingRef.current = false;
    remember(viewport);
    if (typeof IntersectionObserver === "undefined") recomputeVisibilityGeometric();
    if (!anchoringRef.current) return;
    if (ignoreScrollUntilBottomRef.current) {
      if (bottom) {
        setJumpTracking(false);
        setFollowing(true);
      } else if (viewport.scrollTop < previousTop) {
        // The programmatic jump lost ground: the user grabbed the scrollbar
        // mid-flight (wheel/touch/keys cancel via cancelProgrammaticScroll).
        // Reconcile follow with the position instead of staying stuck.
        setJumpTracking(false);
        setFollowing(false);
      }
      return;
    }
    // Geometry maintenance can emit a scroll event after remember(). Only a
    // changed position is a reader scroll; do not release an oversized read.
    if (readAnchorRef.current) {
      if (viewport.scrollTop === previousTop) return;
      userReadPendingRef.current = false;
      previousRequestIdRef.current = readAnchorRef.current.requestId;
    }
    // A real reader scroll releases the turn anchor; growth no longer holds.
    turnAnchorRef.current = null;
    setFollowing(bottom);
  }, [measure, remember, recomputeVisibilityGeometric, setFollowing, setJumpTracking]);

  /* ---- mount + per-commit scroll maintenance ------------------------------ */

  // Every commit may change intrinsic content height, even when props retain identity.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    if (readAnchorRef.current) {
      maintainRead();
      mountedRef.current = true;
      return;
    }
    if (!mountedRef.current) {
      if (restorePendingRef.current && initialMessageId !== undefined) {
        const el = itemsRef.current.get(initialMessageId);
        if (el) {
          tryRestore();
        } else if (anchoringRef.current) {
          // Saved id not mounted yet: fall back to the anchor, keep retrying on
          // later registrations until a user gesture or explicit command cancels.
          viewport.scrollTop = viewport.scrollHeight;
        }
      } else if (anchoringRef.current) {
        viewport.scrollTop = viewport.scrollHeight;
        followingRef.current = true;
      } else {
        followingRef.current = false;
      }
      emitState({ following: followingRef.current });
      measure(viewport);
      remember(viewport);
      mountedRef.current = true;
      return;
    }

    const previous = snapshotRef.current;
    const anchorChanged = previousAnchorRef.current !== scrollAnchor;
    previousAnchorRef.current = scrollAnchor;

    if (!anchoringRef.current) {
      setJumpTracking(false);
      setFollowing(false);
    } else if (anchorChanged) {
      const wasAtBottom = previous.scrollHeight - previous.scrollTop - viewport.clientHeight <= thresholdRef.current;
      if (wasAtBottom) setFollowing(true);
    }

    // A newly appended scrollAnchor row anchors its turn. Only rows starting
    // at the previous content end qualify, so prepended history rows carrying
    // scrollAnchor never yank the viewport.
    const pendingAnchorId = pendingAnchorIdRef.current;
    pendingAnchorIdRef.current = null;
    if (pendingAnchorId && !restorePendingRef.current) {
      const anchorEl = itemsRef.current.get(pendingAnchorId);
      if (anchorEl && itemTopWithinViewport(anchorEl) >= previous.scrollHeight - thresholdRef.current) {
        anchorTurn(anchorEl, pendingAnchorId);
        remember(viewport);
        return;
      }
    }

    const currentFirstKey = firstDomItemId();
    const firstItemChanged = !Object.is(previous.firstItemKey, currentFirstKey);
    if (firstItemChanged && !followingRef.current) {
      viewport.scrollTop += viewport.scrollHeight - previous.scrollHeight;
    } else if (anchoringRef.current && followingRef.current && !restorePendingRef.current) {
      viewport.scrollTop = viewport.scrollHeight;
    }
    measure(viewport);
    remember(viewport);
  });

  /* ---- content growth re-pin + visibility fallback ------------------------ */

  useLayoutEffect(() => {
    const viewport = viewportElement;
    const content = viewport?.firstElementChild;
    if (!viewport || !content || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (readAnchorRef.current) {
        maintainRead();
        return;
      }
      // An in-flight programmatic jump-to-latest keeps re-targeting the moving
      // bottom, so streaming growth mid-flight cannot strand the jump.
      const jumpingToLatest = ignoreScrollUntilBottomRef.current;
      if (anchoringRef.current && (followingRef.current || jumpingToLatest) && !restorePendingRef.current) {
        viewport.scrollTop = viewport.scrollHeight;
        if (jumpingToLatest && measure(viewport)) {
          setJumpTracking(false);
          setFollowing(true);
        }
      } else if (turnAnchorRef.current && !restorePendingRef.current) {
        // Turn anchored: the reply streams into the room below without moving
        // the reader. Once it fills the viewport the reader is back at the
        // live edge and follow-output takes over from the anchor.
        const maxTop = Math.max(viewport.scrollHeight - viewport.clientHeight, 0);
        if (anchoringRef.current && maxTop > turnAnchorRef.current.top + thresholdRef.current) {
          turnAnchorRef.current = null;
          setFollowing(true);
        } else if (viewport.scrollTop > maxTop) {
          viewport.scrollTop = maxTop;
        }
      }
      measure(viewport);
      remember(viewport);
      if (typeof IntersectionObserver === "undefined") recomputeVisibilityGeometric();
    });
    observer.observe(content);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [maintainRead, measure, remember, recomputeVisibilityGeometric, setFollowing, setJumpTracking, viewportElement]);

  useEffect(() => {
    if (!viewportElement) return;
    if (typeof IntersectionObserver !== "undefined") {
      const observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            const id = (entry.target as HTMLElement).dataset.messageId;
            if (!id) continue;
            // Frozen rule: half-visible OR an oversize item filling the viewport
            // (whose intersectionRatio can never reach the 0.5 threshold).
            const rootHeight = entry.rootBounds?.height ?? 0;
            const fillsViewport = rootHeight > 0 && entry.intersectionRect.height >= rootHeight * 0.99;
            setMessageVisible(id, entry.isIntersecting && (entry.intersectionRatio >= 0.5 || fillsViewport));
          }
        },
        { root: viewportElement, threshold: [0, 0.5] },
      );
      observerRef.current = observer;
      for (const el of itemsRef.current.values()) observer.observe(el);
      return () => {
        observer.disconnect();
        observerRef.current = null;
      };
    }
    recomputeVisibilityGeometric();
    window.addEventListener("resize", recomputeVisibilityGeometric);
    return () => window.removeEventListener("resize", recomputeVisibilityGeometric);
  }, [recomputeVisibilityGeometric, setMessageVisible, viewportElement]);

  /* ---- context ------------------------------------------------------------ */

  const contextValue = useMemo<ScrollerContextValue>(
    () => ({
      commands: commandsRef.current,
      isFollowing: () => anchoringRef.current && followingRef.current,
      isReading: () => readAnchorRef.current !== undefined && followingRef.current,
      registerViewport,
      handleViewportScroll: handleScroll,
      registerItem,
      subscribeState: (listener) => {
        stateListenersRef.current.add(listener);
        return () => stateListenersRef.current.delete(listener);
      },
      getState: () => stateRef.current,
      subscribeVisibility: (messageId, listener) => {
        return subscribeVisibility(visibilityListenersRef.current, messageId, listener);
      },
      isMessageVisible: (messageId) => visibleRef.current.has(messageId),
    }),
    [registerViewport, registerItem, handleScroll],
  );
  contextValue.commands = commandsRef.current;

  return <ScrollerContext.Provider value={contextValue}>{children}</ScrollerContext.Provider>;
}

/** State + commands context for the conversation scroller compound anatomy. */
export function MessageScrollerProvider(props: MessageScrollerProviderProps) {
  useScrollerLaneCss();
  return <MessageScrollerProviderImpl {...props} />;
}

/* -------------------------------------------------------------------------- */
/* Viewport / Content / Item / Button                                        */
/* -------------------------------------------------------------------------- */

/** Scrollable region (role=region, single tab stop) with optional edge fades. */
export const MessageScrollerViewport: ForwardRefExoticComponent<
  MessageScrollerViewportProps & RefAttributes<HTMLDivElement>
> = forwardRef<HTMLDivElement, MessageScrollerViewportProps>(function MessageScrollerViewport(
  { fade, className, children, "aria-label": ariaLabel, ...props },
  ref,
) {
  useScrollerLaneCss();
  const resolvedFade = fade ?? false;
  const { registerViewport, handleViewportScroll } = useScrollerContext("MessageScrollerViewport");
  const { atTop, atBottom, autoscrolling } = useMessageScrollerState();
  const composedRef = useCallback(
    (el: HTMLDivElement | null) => {
      registerViewport(el);
      if (typeof ref === "function") ref(el);
      else if (ref) (ref as { current: HTMLDivElement | null; }).current = el;
    },
    [registerViewport, ref],
  );
  return (
    <div
      ref={composedRef}
      data-slot="message-scroller-viewport"
      className={cn("sui-msg-scroller-viewport", resolvedFade && "sui-scroll-fade", className)}
      data-fade-top={atTop ? "false" : "true"}
      data-fade-bottom={atBottom ? "false" : "true"}
      data-autoscrolling={autoscrolling ? "true" : undefined}
      role="region"
      aria-label={ariaLabel ?? "Conversation messages"}
      tabIndex={0}
      onScroll={handleViewportScroll}
      {...props}
    >
      {children}
    </div>
  );
}) as ForwardRefExoticComponent<MessageScrollerViewportProps & RefAttributes<HTMLDivElement>>;

/** Message list container; defaults to role='log' (live-log semantics). */
export function MessageScrollerContent({ className, role, ...props }: MessageScrollerContentProps) {
  useScrollerLaneCss();
  return (
    <div
      data-slot="message-scroller-content"
      role={role ?? "log"}
      className={cn("sui-msg-scroller-content", className)}
      {...props}
    />
  );
}

type ItemStyle = CSSProperties & { "--sui-msg-intrinsic"?: string; };

/** One registered message wrapper with content-visibility optimization. */
export function MessageScrollerItem({
  messageId,
  intrinsicSize = 96,
  scrollAnchor = false,
  className,
  style,
  ...props
}: MessageScrollerItemProps) {
  useScrollerLaneCss();
  const { registerItem } = useScrollerContext("MessageScrollerItem");
  const ref = useCallback(
    (el: HTMLDivElement | null) => registerItem(messageId, el, scrollAnchor),
    [registerItem, messageId, scrollAnchor],
  );
  const itemStyle: ItemStyle = { ...(style as ItemStyle), "--sui-msg-intrinsic": `${intrinsicSize}px` };
  return (
    <div
      ref={ref}
      data-slot="message-scroller-item"
      data-message-id={messageId}
      data-scroll-anchor={scrollAnchor ? "true" : undefined}
      className={cn("sui-msg-scroller-item", className)}
      style={itemStyle}
      {...props}
    />
  );
}

type ScrollerButtonTarget = "latest" | "start" | { messageId: string; };

function targetKind(target: ScrollerButtonTarget): "end" | "start" | "message" {
  if (target === "start") return "start";
  if (target === "latest") return "end";
  return "message";
}

type FrameButtonProps = MessageScrollerButtonProps & {
  target: ScrollerButtonTarget;
  /** Whether there is content to scroll toward in this button's direction. */
  active: boolean;
  label: string;
  onJump: () => void;
};

/**
 * Frozen button contract: a real button that stays rendered, going inert
 * (no focus stop, data-active=false) while there is nothing to scroll toward.
 */
function MessageScrollerFrameButton({
  target,
  active,
  label,
  onJump,
  behavior = "smooth",
  className,
  children,
  ...props
}: FrameButtonProps) {
  useScrollerLaneCss();
  return (
    <button
      type="button"
      data-slot="message-scroller-button"
      data-target={targetKind(target)}
      data-active={active ? "true" : "false"}
      inert={!active}
      tabIndex={active ? 0 : -1}
      aria-label={label}
      className={cn("sui-msg-scroller-button", className)}
      onClick={onJump}
      {...props}
    >
      {children ?? <span aria-hidden="true">{targetKind(target) === "start" ? "↑" : "↓"}</span>}
    </button>
  );
}

function MessageScrollerLatestButton({ "aria-label": ariaLabel, ...props }: MessageScrollerButtonProps) {
  const { commands, isReading } = useScrollerContext("MessageScrollerButton");
  const { atBottom } = useMessageScrollerState();
  return (
    <MessageScrollerFrameButton
      {...props}
      target="latest"
      active={!atBottom && !isReading()}
      label={ariaLabel ?? "Jump to latest"}
      onJump={() => commands.scrollToBottom(props.behavior ?? "smooth")}
    />
  );
}

function MessageScrollerStartButton(props: MessageScrollerButtonProps) {
  const { commands } = useScrollerContext("MessageScrollerButton");
  const { atTop } = useMessageScrollerState();
  return (
    <MessageScrollerFrameButton
      {...props}
      target="start"
      active={!atTop}
      label="Jump to start"
      onJump={() => commands.scrollToTop(props.behavior ?? "smooth")}
    />
  );
}

function MessageScrollerTargetButton({
  target,
  ...props
}: MessageScrollerButtonProps & { target: { messageId: string; }; }) {
  const { commands } = useScrollerContext("MessageScrollerButton");
  const visible = useMessageVisibility(target.messageId);
  return (
    <MessageScrollerFrameButton
      {...props}
      target={target}
      active={!visible}
      label="Jump to message"
      onJump={() => commands.scrollToMessage(target.messageId, { behavior: props.behavior ?? "smooth", peek: true })}
    />
  );
}

/** Jump affordance; inert while already at the target region. */
export function MessageScrollerButton({ target = "latest", ...props }: MessageScrollerButtonProps) {
  if (target === "latest") {
    return <MessageScrollerLatestButton {...props} />;
  }
  if (target === "start") return <MessageScrollerStartButton {...props} />;
  return <MessageScrollerTargetButton target={target} {...props} />;
}

/* -------------------------------------------------------------------------- */
/* Hooks (pay-for-use subscriptions)                                          */
/* -------------------------------------------------------------------------- */

/** Imperative scroller commands from the ambient provider. */
export function useMessageScroller(): MessageScrollerCommands {
  return useScrollerContext("useMessageScroller").commands;
}

/** Whether a registered message is at least half visible (or fills the viewport). */
export function useMessageVisibility(messageId: string): boolean {
  const { subscribeVisibility, isMessageVisible } = useScrollerContext("useMessageVisibility");
  const subscribe = useCallback(
    (listener: () => void) => subscribeVisibility(messageId, listener),
    [subscribeVisibility, messageId],
  );
  const getSnapshot = useCallback(() => isMessageVisible(messageId), [isMessageVisible, messageId]);
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}

/**
 * The on-screen band: the first and last ids of `order` that are visible, or
 * `undefined` when none is. Stable while the band does not move.
 */
export function useMessageBand(order: readonly string[]): readonly [first: string, last: string] | undefined {
  const { subscribeVisibility, isMessageVisible } = useScrollerContext("useMessageBand");
  const key = order.join("\n");
  const subscribe = useCallback(
    (listener: () => void) => {
      const stops = key === "" ? [] : key.split("\n").map((id) => subscribeVisibility(id, listener));
      return () => { for (const stop of stops) stop(); };
    },
    [subscribeVisibility, key],
  );
  const getSnapshot = useCallback(() => {
    const visible = key === "" ? [] : key.split("\n").filter((id) => isMessageVisible(id));
    return visible.length === 0 ? "" : `${visible[0]}\n${visible[visible.length - 1]}`;
  }, [isMessageVisible, key]);
  const band = useSyncExternalStore(subscribe, getSnapshot, () => "");
  return useMemo(() => {
    if (band === "") return undefined;
    const [first, last] = band.split("\n");
    return [first!, last!] as const;
  }, [band]);
}

/** Viewport position + follow state, subscribed only by callers of this hook. */
export function useMessageScrollerState(): ViewportState {
  const { subscribeState, getState } = useScrollerContext("useMessageScrollerState");
  return useSyncExternalStore(subscribeState, getState, getState);
}
