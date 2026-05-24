export const MATERIA_THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const;

export type MateriaThinkingLevel = (typeof MATERIA_THINKING_LEVELS)[number];

export function isMateriaThinkingLevel(value: unknown): value is MateriaThinkingLevel {
  return typeof value === 'string' && (MATERIA_THINKING_LEVELS as readonly string[]).includes(value);
}
