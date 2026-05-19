import type { MateriaBehaviorConfig } from '../../../loadoutModel.js';
import type { LoadoutSourceScope, SaveTarget } from '../../types.js';

export type MateriaLockState = 'locked' | 'unlocked';

export interface MateriaEditPolicyInput {
  id: string;
  definition?: MateriaBehaviorConfig;
  source?: LoadoutSourceScope;
  defaultMateriaIds: string[];
}

export interface MateriaEditPolicy {
  id: string;
  source: LoadoutSourceScope | undefined;
  isBuiltIn: boolean;
  isOverriddenBuiltIn: boolean;
  lockState: MateriaLockState;
  saveScope: SaveTarget;
  canSave: boolean;
  saveBlockedReason: string | null;
  canDelete: boolean;
  deleteTitle: string;
  canToggleLock: boolean;
  lockTitle: string;
}

export interface MateriaSelectorItem extends MateriaEditPolicy {
  label: string;
  group: string;
  type: 'agent' | 'utility' | 'unknown';
  description: string;
}

function writableSource(source: LoadoutSourceScope | undefined): SaveTarget | undefined {
  return source === 'user' || source === 'project' || source === 'explicit' ? source : undefined;
}

export function getMateriaEditPolicy({ id, definition, source, defaultMateriaIds }: MateriaEditPolicyInput): MateriaEditPolicy {
  const isBuiltIn = defaultMateriaIds.includes(id);
  const effectiveSource = source ?? (isBuiltIn ? 'default' : undefined);
  const writable = writableSource(effectiveSource);
  const lockState: MateriaLockState = definition?.lockState === 'locked' ? 'locked' : 'unlocked';
  const canToggleLock = writable !== undefined;
  const canDelete = writable !== undefined;
  const saveScope = writable ?? 'user';
  const lockedSelected = writable !== undefined && lockState === 'locked';

  return {
    id,
    source: effectiveSource,
    isBuiltIn,
    isOverriddenBuiltIn: isBuiltIn && effectiveSource !== undefined && effectiveSource !== 'default',
    lockState,
    saveScope,
    canSave: !lockedSelected,
    saveBlockedReason: lockedSelected ? `Materia definition ${id} is locked. Unlock it before saving changes.` : null,
    canDelete,
    deleteTitle: canDelete ? `Delete ${id} from ${writable} scope` : 'Built-in materia cannot be deleted.',
    canToggleLock,
    lockTitle: canToggleLock ? `${lockState === 'locked' ? 'Unlock' : 'Lock'} ${id}` : 'Built-in materia cannot be locked. Save an override first.',
  };
}

export function buildMateriaSelectorItems(
  materia: Record<string, MateriaBehaviorConfig> | undefined,
  materiaSources: Record<string, LoadoutSourceScope>,
  defaultMateriaIds: string[],
): MateriaSelectorItem[] {
  return Object.entries(materia ?? {})
    .map(([id, definition]) => {
      const policy = getMateriaEditPolicy({ id, definition, source: materiaSources[id], defaultMateriaIds });
      const type: MateriaSelectorItem['type'] = definition.type === 'agent' || definition.type === 'utility' ? definition.type : 'unknown';
      return {
        ...policy,
        label: String(definition.label ?? id),
        group: String(definition.group ?? ''),
        type,
        description: String(definition.description ?? ''),
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}
