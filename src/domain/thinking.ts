/**
 * Canonical materia thinking-level vocabulary (pure domain primitive).
 *
 * Zero dependencies. This is the lowest-level primitive shared by domain,
 * application, config, runtime, and WebUI layers, so it lives in the domain
 * layer where it can be imported by other domain modules (e.g. model policy)
 * without crossing layer boundaries.
 */
export const MATERIA_THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const;

export type MateriaThinkingLevel = (typeof MATERIA_THINKING_LEVELS)[number];

export function isMateriaThinkingLevel(value: unknown): value is MateriaThinkingLevel {
  return typeof value === 'string' && (MATERIA_THINKING_LEVELS as readonly string[]).includes(value);
}
