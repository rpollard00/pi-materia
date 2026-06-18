import { describe, expect, it } from 'vitest';
import {
  computeFeedScrollTop,
  FEED_NEAR_TOP_PX,
} from './useEventFeedScroll.js';

describe('computeFeedScrollTop (scroll preservation logic)', () => {
  it('re-pins to the top when sticking to the latest events', () => {
    // Regardless of where the user was or how much content was prepended,
    // sticking to the top always re-anchors scrollTop at 0.
    expect(
      computeFeedScrollTop({
        stickToTop: true,
        currentScrollTop: 500,
        prevScrollHeight: 1000,
        newScrollHeight: 1400,
      }),
    ).toBe(0);

    expect(
      computeFeedScrollTop({
        stickToTop: true,
        currentScrollTop: 0,
        prevScrollHeight: null,
        newScrollHeight: 0,
      }),
    ).toBe(0);
  });

  it('returns null on the very first layout (nothing to preserve against)', () => {
    expect(
      computeFeedScrollTop({
        stickToTop: false,
        currentScrollTop: 320,
        prevScrollHeight: null,
        newScrollHeight: 1200,
      }),
    ).toBeNull();
  });

  it('returns null when the content height is unchanged (no prepend)', () => {
    expect(
      computeFeedScrollTop({
        stickToTop: false,
        currentScrollTop: 320,
        prevScrollHeight: 1200,
        newScrollHeight: 1200,
      }),
    ).toBeNull();
  });

  it('shifts scrollTop by the prepended height so the same content stays in view', () => {
    // 200px of newer events were prepended above the viewport. The user was
    // reading content at scrollTop 500; the same content is now 200px lower.
    const next = computeFeedScrollTop({
      stickToTop: false,
      currentScrollTop: 500,
      prevScrollHeight: 1000,
      newScrollHeight: 1200,
    });
    expect(next).toBe(700);
  });

  it('shifts by a negative delta when content above the viewport shrank', () => {
    const next = computeFeedScrollTop({
      stickToTop: false,
      currentScrollTop: 500,
      prevScrollHeight: 1200,
      newScrollHeight: 1100,
    });
    expect(next).toBe(400);
  });

  it('does not mutate its arguments (pure helper)', () => {
    const args = {
      stickToTop: false,
      currentScrollTop: 500,
      prevScrollHeight: 1000,
      newScrollHeight: 1300,
    };
    const snapshot = { ...args };
    computeFeedScrollTop(args);
    expect(args).toEqual(snapshot);
  });
});

describe('FEED_NEAR_TOP_PX', () => {
  it('is a small positive threshold so the top is treated as "at the latest"', () => {
    expect(typeof FEED_NEAR_TOP_PX).toBe('number');
    expect(FEED_NEAR_TOP_PX).toBeGreaterThan(0);
    expect(FEED_NEAR_TOP_PX).toBeLessThan(50);
  });
});
