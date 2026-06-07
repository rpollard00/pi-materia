export interface CanvasPointParams {
  clientX: number;
  clientY: number;
  offsetWidth: number;
  offsetHeight: number;
  rectWidth: number;
  rectHeight: number;
  rectLeft: number;
  rectTop: number;
}

/**
 * Converts pointer client coordinates to unscaled canvas-space coordinates.
 *
 * When a canvas element is CSS-transformed (e.g. `transform: scale(zoom)`), the
 * element's `getBoundingClientRect()` returns the visual (scaled) size, but the
 * canvas coordinate system operates in the unscaled (intrinsic) space. This
 * helper divides the visual offset by the scale factor to map the pointer
 * position into the correct unscaled coordinate system.
 *
 * At 100% zoom (no CSS transform), `offsetWidth === rect.width` and `offsetHeight === rect.height`,
 * so the scale is 1 and behavior is unchanged.
 */
export function scaleCanvasPoint(params: CanvasPointParams): { x: number; y: number } {
  const scaleX = params.rectWidth > 0 ? params.offsetWidth / params.rectWidth : 1;
  const scaleY = params.rectHeight > 0 ? params.offsetHeight / params.rectHeight : 1;
  return {
    x: (params.clientX - params.rectLeft) * scaleX,
    y: (params.clientY - params.rectTop) * scaleY,
  };
}
