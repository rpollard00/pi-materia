import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from 'react';

/**
 * Pixels from the top within which the feed is treated as "at the latest".
 *
 * Keeps the stick-to-top behavior resilient to sub-pixel rounding so a user
 * parked at the very top is never bounced by a one-pixel drift.
 */
export const FEED_NEAR_TOP_PX = 4;

/**
 * Decide the next `scrollTop` for the feed after a snapshot change.
 *
 * - **Sticking to the top** re-pins to `0` so freshly prepended events stay
 *   visible as the cast progresses.
 * - **Preserving position**: when the user has scrolled back into older events
 *   and content is prepended above the viewport, shift `scrollTop` by the
 *   height delta so the same content stays in view — the feed never yanks the
 *   user back to the newest events mid-read.
 *
 * Returns `null` when no adjustment is needed (identical height while not
 * sticking, or the very first layout with nothing to preserve against), letting
 * the caller leave the container's scroll position untouched. This is the
 * pure, layout-independent core of {@link useEventFeedScroll} so it can be unit
 * tested without a real scrolling viewport.
 */
export function computeFeedScrollTop(args: {
  stickToTop: boolean;
  currentScrollTop: number;
  prevScrollHeight: number | null;
  newScrollHeight: number;
}): number | null {
  const { stickToTop, currentScrollTop, prevScrollHeight, newScrollHeight } = args;
  if (stickToTop) return 0;
  if (prevScrollHeight === null) return null;
  const delta = newScrollHeight - prevScrollHeight;
  if (delta === 0) return null;
  return currentScrollTop + delta;
}

export interface EventFeedScrollApi {
  /** Ref attached to the feed's scroll container element. */
  containerRef: RefObject<HTMLDivElement | null>;
  /** `onScroll` handler attached to the same scroll container element. */
  onScroll: () => void;
  /** Whether the user is scrolled away from the newest (top) events. */
  showReturnToLatest: boolean;
  /** Re-pin the feed to the newest events (Return to latest button action). */
  scrollToLatest: () => void;
}

/**
 * Scroll controller for the newest-first runtime event feed.
 *
 * The newest events live at the top of the scroll container
 * ({@link MonitorPanel}). While the user is at/near the top, freshly prepended
 * events stay visible by re-pinning to the top. Once the user scrolls back into
 * older events, the visible scroll position is preserved across SSE snapshot
 * refreshes and prepended events so the feed never bounces them back to the
 * top. A {@link EventFeedScrollApi.scrollToLatest} action and a
 * {@link EventFeedScrollApi.showReturnToLatest} flag expose a "Return to
 * latest" affordance for the host to render.
 *
 * Both Pretty and Raw modes render into the same container, so preservation
 * applies regardless of the active view mode.
 */
export function useEventFeedScroll<T>(events: readonly T[]): EventFeedScrollApi {
  const containerRef = useRef<HTMLDivElement | null>(null);
  /** Whether the feed should re-pin to the top when new events arrive. */
  const stickToTopRef = useRef(true);
  /** Last measured `scrollHeight`, used to compute the prepend delta. */
  const prevScrollHeightRef = useRef<number | null>(null);
  const [showReturnToLatest, setShowReturnToLatest] = useState(false);

  // Re-pin or preserve scroll position synchronously (before paint) whenever
  // the event list changes, so prepended events never cause a visible bounce.
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const newScrollHeight = container.scrollHeight;
    const next = computeFeedScrollTop({
      stickToTop: stickToTopRef.current,
      currentScrollTop: container.scrollTop,
      prevScrollHeight: prevScrollHeightRef.current,
      newScrollHeight,
    });
    if (next !== null) {
      container.scrollTop = next;
    }
    prevScrollHeightRef.current = newScrollHeight;
  }, [events]);

  const onScroll = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const atTop = container.scrollTop <= FEED_NEAR_TOP_PX;
    stickToTopRef.current = atTop;
    setShowReturnToLatest(!atTop);
  }, []);

  const scrollToLatest = useCallback(() => {
    const container = containerRef.current;
    stickToTopRef.current = true;
    if (container) {
      // Reset the height baseline so the next prepend preservation is correct.
      prevScrollHeightRef.current = container.scrollHeight;
      // Prefer smooth scrolling in real browsers; fall back to a direct set
      // where smooth scrolling is unavailable (e.g. the jsdom test DOM).
      if (typeof container.scrollTo === 'function') {
        container.scrollTo({ top: 0, behavior: 'smooth' });
      } else {
        container.scrollTop = 0;
      }
    }
    setShowReturnToLatest(false);
  }, []);

  return { containerRef, onScroll, showReturnToLatest, scrollToLatest };
}
