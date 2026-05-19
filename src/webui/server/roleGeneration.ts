import type { IncomingMessage, ServerResponse } from 'node:http';
import { errorMessage, isPlainObject, readJsonBody, sendJson } from './http.js';

export type MateriaGeneratorConfig = { output: string; items?: string; listType: 'array'; itemType: string; as?: string; cursor?: string; done?: string };
export const CANONICAL_WORK_ITEMS_GENERATOR_CONFIG: MateriaGeneratorConfig = { output: 'workItems', items: 'state.workItems', listType: 'array', itemType: 'workItem', as: 'workItem', cursor: 'workItemIndex', done: 'end' };
export type MateriaRolePromptGenerationRequest = { brief: string; generates?: MateriaGeneratorConfig | null };
export type MateriaRoleGenerationModelResolution = { requestedModel: string | null; effectiveModel: string | null; fallback: boolean; warnings: string[] };
export type MateriaRolePromptGenerationResult =
  | { ok: true; prompt: string; model?: string; provider?: string; api?: string; thinking?: string; isolated: true; warnings?: string[]; modelResolution?: MateriaRoleGenerationModelResolution }
  | { ok: false; error: string; code: 'invalid_brief' | 'disabled' | 'generation_failed' };

export interface RoleGenerationRouteDeps {
  generateMateriaRole?: (request: MateriaRolePromptGenerationRequest) => Promise<MateriaRolePromptGenerationResult>;
}

const MAX_ROLE_BRIEF_CHARS = 4_000;

function validateMateriaRoleBrief(brief: unknown): { ok: true; brief: string } | Extract<MateriaRolePromptGenerationResult, { ok: false }> {
  if (typeof brief !== 'string') return { ok: false, code: 'invalid_brief', error: 'Expected brief to be a string.' };
  const trimmed = brief.trim();
  if (!trimmed) return { ok: false, code: 'invalid_brief', error: 'Role brief cannot be empty.' };
  if (trimmed.length > MAX_ROLE_BRIEF_CHARS) return { ok: false, code: 'invalid_brief', error: `Role brief is too long; limit is ${MAX_ROLE_BRIEF_CHARS} characters.` };
  return { ok: true, brief: trimmed };
}

function roleGenerationStatus(result: Extract<MateriaRolePromptGenerationResult, { ok: false }>): number {
  if (result.code === 'invalid_brief') return 400;
  if (result.code === 'disabled') return 403;
  return 500;
}

function validateMateriaGeneratorConfig(value: unknown): MateriaGeneratorConfig | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (!isPlainObject(value)) throw new Error('Expected generates to be an object or null.');
  const canonical = CANONICAL_WORK_ITEMS_GENERATOR_CONFIG;
  const output = trimmedRequired(value.output, 'generates.output');
  const itemType = trimmedRequired(value.itemType, 'generates.itemType');
  const items = optionalTrimmed(value.items, 'generates.items');
  const as = optionalTrimmed(value.as, 'generates.as');
  const cursor = optionalTrimmed(value.cursor, 'generates.cursor');
  const done = optionalTrimmed(value.done, 'generates.done');
  if (value.listType !== canonical.listType) throw new Error('Expected generates.listType to be "array".');
  const isCanonical = output === canonical.output
    && itemType === canonical.itemType
    && (items === undefined || items === `state.${canonical.output}`)
    && (as === undefined || as === canonical.as)
    && (cursor === undefined || cursor === canonical.cursor)
    && (done === undefined || done === canonical.done);
  if (!isCanonical) {
    throw new Error('Obsolete generates metadata may only describe the canonical workItems contract. Use generator: true and canonical workItems; custom generates.output aliases such as tasks or work are not active runtime generator outputs.');
  }
  return { ...canonical, items: items ?? `state.${canonical.output}` };
}

function trimmedRequired(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Expected ${field} to be a non-empty string.`);
  return value.trim();
}

function optionalTrimmed(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Expected ${field} to be a non-empty string when configured.`);
  return value.trim();
}

function sendRoleGenerationError(res: ServerResponse, status: number, code: string, message: string) {
  sendJson(res, status, { ok: false, error: { code, message } });
}

export async function handleRoleGenerationRoute(req: IncomingMessage, res: ServerResponse, deps: RoleGenerationRouteDeps) {
  if (req.method !== 'POST') {
    sendRoleGenerationError(res, 405, 'method_not_allowed', 'Use POST to generate a Materia role prompt.');
    return;
  }
  if (!deps.generateMateriaRole) {
    sendRoleGenerationError(res, 503, 'unavailable', 'Materia role generation API is unavailable for this server.');
    return;
  }
  try {
    const body = await readJsonBody(req);
    if (!isPlainObject(body) || !('brief' in body)) {
      sendRoleGenerationError(res, 400, 'invalid_request', 'Expected JSON body with string field "brief".');
      return;
    }
    const validation = validateMateriaRoleBrief(body.brief);
    if (!validation.ok) {
      sendRoleGenerationError(res, 400, validation.code, validation.error);
      return;
    }
    let generates: MateriaGeneratorConfig | null | undefined;
    try {
      generates = validateMateriaGeneratorConfig(body.generates);
    } catch (error) {
      sendRoleGenerationError(res, 400, 'invalid_request', errorMessage(error));
      return;
    }
    const result = await deps.generateMateriaRole({ brief: validation.brief, generates });
    if (!result.ok) {
      sendRoleGenerationError(res, roleGenerationStatus(result), result.code, result.error);
      return;
    }
    sendJson(res, 200, {
      ok: true,
      prompt: result.prompt,
      model: result.model,
      provider: result.provider,
      api: result.api,
      thinking: result.thinking,
      isolated: result.isolated,
      warnings: result.warnings ?? result.modelResolution?.warnings ?? [],
      modelResolution: result.modelResolution,
    });
  } catch (error) {
    const message = errorMessage(error);
    const invalidJson = message === 'Invalid JSON body' || message === 'Request body too large';
    sendRoleGenerationError(res, invalidJson ? 400 : 500, invalidJson ? 'invalid_request' : 'generation_failed', message);
  }
}
