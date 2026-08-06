import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";

/** Semantic roles used by Materia's terminal presentation layer. */
export type MateriaThemeRole =
  | "accent"
  | "success"
  | "warning"
  | "error"
  | "muted"
  | "dim"
  | "text";

/** The Pi theme token selected for each Materia semantic role. */
export const MATERIA_THEME_TOKENS: Readonly<Record<MateriaThemeRole, ThemeColor>> = {
  accent: "accent",
  success: "success",
  warning: "warning",
  error: "error",
  muted: "muted",
  dim: "dim",
  text: "text",
};

export const MATERIA_THEME_ROLE_TOKENS = MATERIA_THEME_TOKENS;

/** The small part of Pi's Theme API required by Materia widgets. */
export type MateriaPiTheme = Pick<Theme, "fg">;

/**
 * Theme operations available to presentation renderers.
 *
 * This adapter deliberately deals in semantic roles rather than ANSI codes or
 * concrete colors. The active Pi theme remains the source of all styling.
 */
export type MateriaTheme = MateriaSemanticTheme;

export interface MateriaSemanticTheme {
  /** Apply the Pi token associated with a Materia role. */
  fg(role: MateriaThemeRole, text: string): string;
  /** Apply a scoped blink while retaining the role's foreground color. */
  blink(role: MateriaThemeRole, text: string): string;
  /** Return a reusable role-aware styling function. */
  style(role: MateriaThemeRole): (text: string) => string;
  /** Resolve a role to its Pi token for callers that need token-level access. */
  token(role: MateriaThemeRole): ThemeColor;
}

/**
 * Create a semantic adapter around the active Pi theme.
 *
 * A missing theme is intentional in transcript, print, and other non-TUI
 * paths. In that case styling is an identity operation and pure renderers stay
 * ANSI-free without needing to know anything about Pi's theme implementation.
 */
export function createMateriaSemanticTheme(
  theme: MateriaPiTheme | null | undefined,
): MateriaSemanticTheme {
  const fg = (role: MateriaThemeRole, text: string): string => {
    if (!theme || typeof theme.fg !== "function") return text;
    return theme.fg(MATERIA_THEME_TOKENS[role], text);
  };

  const blink = (role: MateriaThemeRole, text: string): string => {
    if (!theme || typeof theme.fg !== "function") return text;
    // Keep the decoration inside Pi's foreground scope. SGR 25 is narrower
    // than a full reset and sits directly after the target text, so a blink
    // cannot leak into adjacent glyphs or reset the semantic foreground.
    return fg(role, `\u001b[5m${text}\u001b[25m`);
  };

  return {
    fg,
    blink,
    style: (role) => (text) => fg(role, text),
    token: (role) => MATERIA_THEME_TOKENS[role],
  };
}

/** Convenient name for consumers that treat the adapter as their widget theme. */
export const createMateriaTheme = createMateriaSemanticTheme;

/** Apply a semantic Materia role without constructing an adapter first. */
export function styleMateriaText(
  theme: MateriaPiTheme | null | undefined,
  role: MateriaThemeRole,
  text: string,
): string {
  return createMateriaSemanticTheme(theme).fg(role, text);
}

/** Alias kept concise for renderers that use a function-style API. */
export const materiaFg = styleMateriaText;
