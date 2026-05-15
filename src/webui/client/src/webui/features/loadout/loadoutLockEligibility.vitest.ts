import { describe, expect, it } from 'vitest';
import type { PipelineConfig } from '../../../loadoutModel.js';
import { getLoadoutLockEligibility } from './loadoutLockEligibility.js';

const alpha = {
  id: 'loadout-alpha',
  source: 'user',
  lockState: 'unlocked',
  entry: 'Socket-1',
  sockets: { 'Socket-1': { type: 'agent', materia: 'Build' } },
} satisfies PipelineConfig;

function eligibility(draftLoadouts: Record<string, PipelineConfig>, baselineLoadouts: Record<string, PipelineConfig> = { Alpha: alpha }) {
  return getLoadoutLockEligibility({
    name: Object.keys(draftLoadouts)[0] ?? 'Alpha',
    lockState: 'locked',
    draftLoadouts,
    baselineLoadouts,
    loadoutSources: Object.fromEntries(Object.keys(draftLoadouts).map((name) => [name, 'user'])),
  });
}

describe('getLoadoutLockEligibility', () => {
  it('allows locking a clean persisted loadout by stable id', () => {
    expect(eligibility({ Alpha: { ...alpha } }).eligible).toBe(true);
  });

  it('blocks new loadouts without a persisted id match', () => {
    expect(eligibility({ Draft: { ...alpha, id: 'new-draft' } }).reason).toMatch(/save or revert pending edits/i);
  });

  it('blocks target-scoped content edits including layout and display-name changes', () => {
    expect(eligibility({ Alpha: { ...alpha, layout: { sockets: { 'Socket-1': { x: 1, y: 2 } } } } }).eligible).toBe(false);
    expect(eligibility({ Renamed: { ...alpha } }).eligible).toBe(false);
  });

  it('does not let unrelated dirty loadouts block a clean target loadout', () => {
    const beta = { ...alpha, id: 'loadout-beta', sockets: { 'Socket-1': { type: 'agent', materia: 'Changed' } } } satisfies PipelineConfig;
    const result = getLoadoutLockEligibility({
      name: 'Alpha',
      lockState: 'locked',
      draftLoadouts: { Alpha: { ...alpha }, Beta: beta },
      baselineLoadouts: { Alpha: alpha, Beta: { ...beta, sockets: alpha.sockets } },
      loadoutSources: { Alpha: 'user', Beta: 'user' },
    });
    expect(result.eligible).toBe(true);
  });

  it('keeps unlocking editable locked loadouts available even with pending edits', () => {
    const result = getLoadoutLockEligibility({
      name: 'Alpha',
      lockState: 'unlocked',
      draftLoadouts: { Alpha: { ...alpha, lockState: 'locked', sockets: { 'Socket-1': { type: 'agent', materia: 'Changed' } } } },
      baselineLoadouts: { Alpha: { ...alpha, lockState: 'locked' } },
      loadoutSources: { Alpha: 'user' },
    });
    expect(result.eligible).toBe(true);
  });
});
