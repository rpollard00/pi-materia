import { CANONICAL_WORK_ITEMS_GENERATOR_CONFIG } from '../../../../../graph/generator.js';
import { TOOL_SCOPE_TOOL_NAMES, resolveToolScope } from '../../../../../domain/toolScope.js';
import { materiaColorChoices, type MateriaConfig, type PipelineSocket, type SocketLayout } from '../../loadoutModel.js';
import type { DragPayload, GeneratedListOutputConfig, MateriaFormState, SocketPropertyFormState } from '../types.js';

export const emptyMateriaForm = (): MateriaFormState => ({
  editingSocketId: '',
  name: '',
  behavior: 'prompt',
  prompt: '',
  toolAccess: 'none',
  model: '',
  thinking: '',
  color: materiaColorChoices[0]?.value ?? '',
  outputFormat: 'json',
  multiTurn: false,
  generator: false,
  utility: '',
  command: '',
  params: '{}',
  timeoutMs: '',
  persistScope: 'user',
});

export const emptySocketPropertyForm = (): SocketPropertyFormState => ({
  maxVisits: '',
  maxEdgeTraversals: '',
  maxOutputBytes: '',
  layoutX: '',
  layoutY: '',
});

export const cloneConfig = <T,>(config: T): T => JSON.parse(JSON.stringify(config)) as T;

export function parseDragPayload(raw: string): DragPayload | undefined {
  try {
    const parsed = JSON.parse(raw) as Partial<DragPayload> | null;
    if (!parsed || (parsed.kind !== 'palette' && parsed.kind !== 'socket') || typeof parsed.materiaId !== 'string' || !parsed.materiaId) return undefined;
    if (parsed.kind === 'socket' && parsed.fromSocket !== undefined && typeof parsed.fromSocket !== 'string') return undefined;
    return parsed as DragPayload;
  } catch {
    return undefined;
  }
}

export function parseJsonObject(raw: string): Record<string, unknown> | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const parsed = JSON.parse(trimmed) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Tool params must be a JSON object.');
  return parsed as Record<string, unknown>;
}

export function commandParts(raw: string): string[] | undefined {
  return raw.split(/\s+/).map((part) => part.trim()).filter(Boolean);
}

export function socketPropertyFormFromSocket(socket?: PipelineSocket, layout?: SocketLayout): SocketPropertyFormState {
  return {
    maxVisits: socket?.limits?.maxVisits === undefined ? '' : String(socket.limits.maxVisits),
    maxEdgeTraversals: socket?.limits?.maxEdgeTraversals === undefined ? '' : String(socket.limits.maxEdgeTraversals),
    maxOutputBytes: socket?.limits?.maxOutputBytes === undefined ? '' : String(socket.limits.maxOutputBytes),
    layoutX: layout?.x === undefined ? '' : String(layout.x),
    layoutY: layout?.y === undefined ? '' : String(layout.y),
  };
}

export function parseOptionalPositiveInteger(label: string, raw: string, errors: string[]): number | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const value = Number(trimmed);
  if (!Number.isInteger(value) || value < 1) {
    errors.push(`${label} must be a positive whole number.`);
    return undefined;
  }
  return value;
}

export function parseOptionalFiniteNumber(label: string, raw: string, errors: string[]): number | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const value = Number(trimmed);
  if (!Number.isFinite(value)) {
    errors.push(`${label} must be a finite number.`);
    return undefined;
  }
  return value;
}

export function canonicalWorkItemsGeneratorConfig(): GeneratedListOutputConfig {
  return { ...CANONICAL_WORK_ITEMS_GENERATOR_CONFIG };
}

export function buildMateriaPatch(form: MateriaFormState): MateriaConfig {
  const name = form.name.trim();
  if (!name) throw new Error('Materia name is required.');
  if (form.behavior === 'tool') {
    const utility = form.utility.trim() || undefined;
    const command = form.command.trim() ? form.command.trim().split(/\s+/) : undefined;
    const params = JSON.parse(form.params.trim() || '{}') as Record<string, unknown>;
    const timeoutMs = form.timeoutMs.trim() ? Number(form.timeoutMs.trim()) : undefined;
    if (!utility && !command) throw new Error('Tool materia must configure a utility alias or command.');
    if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) throw new Error('Timeout ms must be a positive number.');
    return {
      materia: {
        [name]: {
          type: 'utility',
          label: name,
          group: 'Utility',
          utility,
          command,
          params,
          timeoutMs,
          parse: form.outputFormat,
          color: form.color.trim() || undefined,
        },
      },
    };
  }
  const toolScope = resolveToolScope(form.toolAccess, TOOL_SCOPE_TOOL_NAMES, 'tools');
  if (!toolScope.ok) throw new Error(`Invalid tool scope: ${toolScope.issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ')}`);
  const agentDefinition = {
    type: 'agent',
    tools: toolScope.value.spec,
    prompt: form.prompt,
    model: form.model.trim() || undefined,
    thinking: form.thinking.trim() || undefined,
    color: form.color.trim() || undefined,
    parse: form.outputFormat,
    multiTurn: form.multiTurn || undefined,
    ...(form.generator ? { generator: true, generates: null } : form.editingSocketId ? { generator: null, generates: null } : {}),
  };
  return {
    materia: {
      [name]: agentDefinition as NonNullable<MateriaConfig['materia']>[string],
    },
  };
}
