import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";
import {
  createMateriaSemanticTheme,
  type MateriaPiTheme,
  type MateriaSemanticTheme,
} from "./theme.js";

/** Render a widget from semantic roles for the current terminal width. */
export type MateriaThemedWidgetRenderer = (
  theme: MateriaSemanticTheme,
  width: number,
) => readonly string[];

/** Render the same widget for transcript and non-TUI consumers. */
export type MateriaPlainWidgetRenderer = (
  width?: number,
) => readonly string[];

export interface MateriaThemedWidgetOptions {
  /** Optional maximum number of rows emitted by the component. */
  maxLines?: number;
  /** Ellipsis used when ANSI-aware width truncation is required. */
  ellipsis?: string;
}

/**
 * A late-bound component for Pi's `setWidget` factory API.
 *
 * The renderer is called on every render, not when the widget is registered.
 * This keeps state and ANSI output out of the component cache and means an
 * invalidation always observes the current semantic model and theme.
 */
export class MateriaThemedWidgetComponent implements Component {
  private readonly options: Required<Pick<MateriaThemedWidgetOptions, "ellipsis">> &
    Omit<MateriaThemedWidgetOptions, "ellipsis">;

  constructor(
    private readonly renderer: MateriaThemedWidgetRenderer,
    private readonly theme: MateriaPiTheme | null | undefined,
    options: MateriaThemedWidgetOptions = {},
  ) {
    this.options = {
      ...options,
      ellipsis: options.ellipsis ?? "…",
    };
  }

  render(width: number): string[] {
    const semanticTheme = createMateriaSemanticTheme(this.theme);
    const rendered = this.renderer(semanticTheme, normalizeWidgetWidth(width));
    return boundMateriaWidgetLines(rendered, width, this.options);
  }

  invalidate(): void {
    // Deliberately uncached: the next render obtains fresh semantic output and
    // cannot retain ANSI sequences produced by an earlier render.
  }
}

/** Factory shape accepted by `ExtensionUIContext.setWidget`. */
/** Short component name for callers that do not need to distinguish the theme path. */
export { MateriaThemedWidgetComponent as MateriaWidgetComponent };

export type MateriaWidgetFactory = (
  tui: TUI,
  theme: Theme,
) => MateriaThemedWidgetComponent;

/**
 * Build a Pi widget factory while keeping theme resolution late-bound to the
 * factory callback supplied by Pi.
 */
export function createMateriaThemedWidgetFactory(
  renderer: MateriaThemedWidgetRenderer,
  options: MateriaThemedWidgetOptions = {},
): MateriaWidgetFactory {
  return (_tui, theme) => new MateriaThemedWidgetComponent(renderer, theme, options);
}

/** Short alias for callers that do not need the Materia prefix. */
export const createThemedWidgetFactory = createMateriaThemedWidgetFactory;
export const createMateriaWidgetFactory = createMateriaThemedWidgetFactory;
export const createThemedMateriaWidgetFactory = createMateriaThemedWidgetFactory;

/**
 * Bound a renderer's output to the host viewport using Pi's ANSI-aware
 * truncation utility. This is exported for components that compose several
 * semantic renderers before handing rows to Pi.
 */
export function boundMateriaWidgetLines(
  lines: readonly string[],
  width: number,
  options: MateriaThemedWidgetOptions = {},
): string[] {
  const boundedWidth = normalizeWidgetWidth(width);
  const maxLines = normalizeMaxLines(options.maxLines);
  const ellipsis = options.ellipsis ?? "…";
  return lines
    .slice(0, maxLines)
    .map((line) => truncateToWidth(String(line), boundedWidth, ellipsis));
}

/**
 * Keep plain rendering explicit and ANSI-free. The supplied renderer is the
 * same pure formatter used by transcript output; this helper does not add
 * theme calls or terminal escapes.
 */
export function renderMateriaWidgetPlain(
  renderer: MateriaPlainWidgetRenderer,
  width?: number,
): string[] {
  return [...renderer(width)];
}

/** A small definition object useful when a caller needs both TUI and plain paths. */
export interface MateriaWidgetDefinition {
  factory: MateriaWidgetFactory;
  renderPlain(width?: number): string[];
}

export function defineMateriaWidget(
  themedRenderer: MateriaThemedWidgetRenderer,
  plainRenderer: MateriaPlainWidgetRenderer,
  options: MateriaThemedWidgetOptions = {},
): MateriaWidgetDefinition {
  return {
    factory: createMateriaThemedWidgetFactory(themedRenderer, options),
    renderPlain: (width) => renderMateriaWidgetPlain(plainRenderer, width),
  };
}

function normalizeWidgetWidth(width: number): number {
  if (!Number.isFinite(width)) return 0;
  return Math.max(0, Math.floor(width));
}

function normalizeMaxLines(value: number | undefined): number {
  if (value === undefined || value === Infinity) return Number.MAX_SAFE_INTEGER;
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

/** Whether this context supports themed widget factories (TUI with a token theme). */
export function supportsThemedWidgets(ctx: ExtensionContext): boolean {
  return ctx.mode === "tui" && typeof ctx.ui.theme?.fg === "function";
}
