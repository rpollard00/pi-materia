import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const styles = readFileSync(`${process.cwd()}/src/webui/client/src/styles.css`, 'utf8');

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

describe('loadout graph connector styling', () => {
  it('keeps every connector stroke solid without changing non-connector dashes', () => {
    const connectorSelectors = [
      '.loadout-loop-cycle-edge path',
      '.loadout-loop-cycle-edge .loadout-loop-cycle-edge-echo',
      '.loadout-parallel-fork path:first-child',
      '.loadout-parallel-fork path:nth-child(2)',
      '.loadout-parallel-barrier path',
      '.loadout-parallel-fan-in path',
      '.loadout-edge path',
      '.loadout-edge-unsatisfied path',
      '.loadout-edge-route-backward path',
      '.loadout-edge-route-loop path',
      '.loadout-edge-generator-input path',
      '.loadout-edge-loop-exit path',
    ];

    for (const selector of connectorSelectors) {
      const rule = styles.match(new RegExp(`${escapeRegExp(selector)}\\s*\\{([^}]*)\\}`, 's'));
      expect(rule, `missing connector rule: ${selector}`).not.toBeNull();
      expect(rule?.[1]).toMatch(/stroke-dasharray:\s*none\s*;/);
      expect(rule?.[1]).not.toMatch(/stroke-dasharray:(?!\s*none\s*;)\s*[^;}]+/);
    }

    const graphStylesStart = styles.indexOf('.loadout-edge-layer');
    const graphStylesEnd = styles.indexOf('.loadout-loop-badge');
    const graphStyles = styles.slice(graphStylesStart, graphStylesEnd);
    expect(graphStyles).not.toMatch(/stroke-dasharray:(?!\s*none\s*;)\s*[^;}]+/);
    expect(styles).toMatch(/\.materia-socket-parallel-prelude \.materia-socket-orb-stage\s*\{[^}]*border-style:\s*dashed;/s);
  });
});
