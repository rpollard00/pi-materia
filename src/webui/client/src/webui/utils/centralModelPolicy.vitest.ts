import { describe, expect, it } from 'vitest';
import {
  normalizeCentralModelCatalogResponse,
  normalizeCentralModelPolicyDocument,
  normalizeCentralModelPolicyResponse,
} from './centralModelPolicy.js';
import type {
  CentralModelCatalog,
  CentralModelPolicyDocument,
} from '../types.js';

function policyDocument(overrides: Partial<CentralModelPolicyDocument> = {}): CentralModelPolicyDocument {
  return {
    id: 'buildga-policy',
    name: 'Buildga policy',
    allow: [{ value: 'zai/glm-4.6' }, { value: 'anthropic/claude' }],
    deny: [{ value: 'forbidden/model' }],
    prefer: [{ value: 'anthropic/claude', label: 'Claude' }],
    thinking: { allow: ['medium', 'high'], max: 'high' },
    severity: 'enforced',
    version: '3',
    updatedAt: '2026-06-24T00:00:00.000Z',
    ...overrides,
  };
}

describe('normalizeCentralModelPolicyDocument', () => {
  it('preserves a well-formed policy document with deduped ref lists', () => {
    const doc = policyDocument({
      allow: [{ value: 'zai/glm-4.6' }, { value: 'zai/glm-4.6' }, { value: 'anthropic/claude' }],
    });
    const normalized = normalizeCentralModelPolicyDocument(doc);
    expect(normalized).toBeDefined();
    expect(normalized!.id).toBe('buildga-policy');
    expect(normalized!.name).toBe('Buildga policy');
    expect(normalized!.allow!.map((ref) => ref.value)).toEqual(['zai/glm-4.6', 'anthropic/claude']);
    expect(normalized!.deny).toEqual([{ value: 'forbidden/model' }]);
    expect(normalized!.prefer).toEqual([{ value: 'anthropic/claude', label: 'Claude' }]);
    expect(normalized!.thinking).toEqual({ allow: ['medium', 'high'], max: 'high' });
    expect(normalized!.severity).toBe('enforced');
    expect(normalized!.version).toBe('3');
    expect(normalized!.updatedAt).toBe('2026-06-24T00:00:00.000Z');
  });

  it('drops invalid ref entries and empty lists', () => {
    const doc = policyDocument({
      allow: [{ value: 'valid/model' }, { value: '' }, { label: 'no-value' }, 'string-not-object'] as unknown as CentralModelPolicyDocument['allow'],
      deny: [],
      prefer: [{ value: 'p/m' }],
    });
    const normalized = normalizeCentralModelPolicyDocument(doc)!;
    expect(normalized.allow!.map((ref) => ref.value)).toEqual(['valid/model']);
    expect(normalized.deny).toBeUndefined();
    expect(normalized.prefer).toEqual([{ value: 'p/m' }]);
  });

  it('returns undefined for non-objects or documents missing an id', () => {
    expect(normalizeCentralModelPolicyDocument(undefined)).toBeUndefined();
    expect(normalizeCentralModelPolicyDocument('nope')).toBeUndefined();
    expect(normalizeCentralModelPolicyDocument({ name: 'no id' })).toBeUndefined();
    expect(normalizeCentralModelPolicyDocument({ id: '   ' })).toBeUndefined();
  });

  it('normalizes a thinking constraint and drops it when empty', () => {
    expect(normalizeCentralModelPolicyDocument({ id: 'a', thinking: { allow: ['high'] } })!.thinking).toEqual({ allow: ['high'] });
    expect(normalizeCentralModelPolicyDocument({ id: 'a', thinking: { max: 'medium' } })!.thinking).toEqual({ max: 'medium' });
    expect(normalizeCentralModelPolicyDocument({ id: 'a', thinking: { allow: [] } })!.thinking).toBeUndefined();
    expect(normalizeCentralModelPolicyDocument({ id: 'a', thinking: 'bad' })!.thinking).toBeUndefined();
  });

  it('coerces an unknown severity to undefined (defaults to enforced at display)', () => {
    const normalized = normalizeCentralModelPolicyDocument({ id: 'a', severity: 'lax' })!;
    expect(normalized.severity).toBeUndefined();
  });
});

describe('normalizeCentralModelPolicyResponse', () => {
  it('extracts the active policy and id from the central envelope', () => {
    const result = normalizeCentralModelPolicyResponse({
      ok: true,
      scope: 'control-plane',
      service: 'pi-materia-central',
      activePolicyId: 'buildga-policy',
      policy: policyDocument(),
    });
    expect(result.activePolicyId).toBe('buildga-policy');
    expect(result.policy?.id).toBe('buildga-policy');
  });

  it('returns an empty result when no policy is configured', () => {
    const result = normalizeCentralModelPolicyResponse({ ok: true });
    expect(result.activePolicyId).toBeUndefined();
    expect(result.policy).toBeUndefined();
  });

  it('tolerates malformed payloads', () => {
    expect(normalizeCentralModelPolicyResponse(undefined)).toEqual({});
    expect(normalizeCentralModelPolicyResponse({ policy: 'nope' })).toEqual({});
    expect(normalizeCentralModelPolicyResponse({ activePolicyId: '   ', policy: { id: '' } })).toEqual({});
  });
});

describe('normalizeCentralModelCatalogResponse', () => {
  it('normalizes a configured catalog with deduped entries', () => {
    const catalog: CentralModelCatalog = {
      entries: [
        { value: 'zai/glm-4.6', label: 'GLM 4.6', vendor: 'zai', supportedThinkingLevels: ['medium', 'high'] },
        { value: 'zai/glm-4.6' },
        { value: '', label: 'empty' },
        { value: 'anthropic/claude', deprecated: true, notes: 'legacy' },
      ],
      updatedAt: '2026-06-24T00:00:00.000Z',
    };
    const normalized = normalizeCentralModelCatalogResponse({ ok: true, catalog });
    expect(normalized).toBeDefined();
    expect(normalized!.entries.map((entry) => entry.value)).toEqual(['zai/glm-4.6', 'anthropic/claude']);
    expect(normalized!.entries[0].label).toBe('GLM 4.6');
    expect(normalized!.entries[1].deprecated).toBe(true);
    expect(normalized!.updatedAt).toBe('2026-06-24T00:00:00.000Z');
  });

  it('returns undefined when no catalog is configured or the payload is malformed', () => {
    expect(normalizeCentralModelCatalogResponse({ ok: true })).toBeUndefined();
    expect(normalizeCentralModelCatalogResponse({ catalog: { entries: 'no' } })).toBeUndefined();
    expect(normalizeCentralModelCatalogResponse(undefined)).toBeUndefined();
    expect(normalizeCentralModelCatalogResponse({ catalog: { entries: [] } })).toEqual({ entries: [] });
  });
});
