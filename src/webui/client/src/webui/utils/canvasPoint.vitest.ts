import { describe, expect, it } from 'vitest';
import { scaleCanvasPoint } from './canvasPoint.js';

describe('scaleCanvasPoint', () => {
  /** Convenience: create default params for a 1000×800 intrinsic canvas. */
  function params(overrides?: Partial<Parameters<typeof scaleCanvasPoint>[0]>) {
    return {
      clientX: 240,
      clientY: 160,
      offsetWidth: 1000,
      offsetHeight: 800,
      rectWidth: 1000,
      rectHeight: 800,
      rectLeft: 50,
      rectTop: 30,
      ...overrides,
    };
  }

  it('returns the visual offset when no CSS scale is applied (100% zoom)', () => {
    const result = scaleCanvasPoint(params());
    // offsetWidth === rectWidth => scale = 1, so result is just client - rect
    expect(result.x).toBe(240 - 50); // 190
    expect(result.y).toBe(160 - 30); // 130
  });

  it('scales coordinates up when CSS scale < 1 (e.g. 50% zoom)', () => {
    const result = scaleCanvasPoint(params({ rectWidth: 500, rectHeight: 400 }));
    // scaleX = 1000 / 500 = 2
    // visual offset = 240 - 50 = 190, unscaled = 190 * 2 = 380
    expect(result.x).toBe(380);
    // visual offset = 160 - 30 = 130, unscaled = 130 * 2 = 260
    expect(result.y).toBe(260);
  });

  it('scales coordinates down when CSS scale > 1 (e.g. 150% zoom)', () => {
    const result = scaleCanvasPoint(params({ rectWidth: 1500, rectHeight: 1200 }));
    // scaleX = 1000 / 1500 = 0.666...
    const scaleX = 1000 / 1500;
    const scaleY = 800 / 1200;
    expect(result.x).toBeCloseTo((240 - 50) * scaleX, 5);
    expect(result.y).toBeCloseTo((160 - 30) * scaleY, 5);
  });

  it('handles a pointer at the top-left origin with 50% zoom', () => {
    const result = scaleCanvasPoint(params({
      clientX: 50,
      clientY: 30,
      rectWidth: 500,
      rectHeight: 400,
    }));
    // visual offset = 0, unscaled = 0
    expect(result.x).toBe(0);
    expect(result.y).toBe(0);
  });

  it('handles a pointer at the bottom-right corner with 50% zoom', () => {
    const result = scaleCanvasPoint(params({
      clientX: 550, // 50 + 500 = far right of scaled element
      clientY: 430, // 30 + 400 = far bottom of scaled element
      rectWidth: 500,
      rectHeight: 400,
    }));
    // visual offset = (550 - 50) = 500, unscaled = 500 * 2 = 1000
    expect(result.x).toBe(1000);
    expect(result.y).toBe(800);
  });

  it('handles zero rect dimensions defensively (fallback scale = 1)', () => {
    const result = scaleCanvasPoint(params({ rectWidth: 0, rectHeight: 0 }));
    expect(result.x).toBe(190);
    expect(result.y).toBe(130);
  });

  it('handles mixed zero dimensions defensively', () => {
    const result = scaleCanvasPoint(params({ rectWidth: 0, rectHeight: 400, offsetWidth: 1000, offsetHeight: 800 }));
    expect(result.x).toBe(190); // scaleX falls back to 1
    expect(result.y).toBe(260); // scaleY = 800/400 = 2, visual offset = 130 * 2 = 260
  });
});
