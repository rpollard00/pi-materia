import type { DragEvent } from 'react';
import { getSocketLabel, socketColor, type MateriaConfig, type PipelineSocket } from '../../../loadoutModel.js';
import { Orb } from '../../components/Orb.js';
import type { DragPayload } from '../../types.js';
import { formatIteratorBehavior, hasIteratorBehavior, isGeneratorSocket, iteratorBadgeLabel } from '../../utils/graphLayout.js';

export interface MateriaPalettePanelProps {
  palette: Array<[string, PipelineSocket]>;
  materia: NonNullable<MateriaConfig['materia']>;
  selectedMateriaId: string | undefined;
  onDragMateria: (payload: DragPayload, event: DragEvent<HTMLElement>) => void;
  onSelectMateria: (id: string | undefined) => void;
}

export function MateriaPalettePanel({ palette, materia, selectedMateriaId, onDragMateria, onSelectMateria }: MateriaPalettePanelProps) {
  return (
    <section className="fantasy-panel p-5">
      <h2 className="text-xl font-bold">Materia palette</h2>
      <p className="mt-1 text-sm text-slate-400">Click once to select for swap/insert, or drag into a socket.</p>
      <div className="mt-4 grid grid-cols-2 gap-3">
        {palette.map(([id, socket], index) => {
          const definition = materia[id];
          const group = typeof definition?.group === 'string' ? definition.group : undefined;
          const description = typeof definition?.description === 'string' ? definition.description : undefined;
          const isIterator = hasIteratorBehavior(socket, materia);
          const isGenerator = isGeneratorSocket(socket, materia);
          const iteratorDetails = isIterator ? formatIteratorBehavior(socket, materia) : undefined;
          const title = [description, iteratorDetails].filter(Boolean).join('\n') || undefined;
          return (
            <button key={id} draggable title={title} data-testid={`palette-${id}`} onDragStart={(event) => onDragMateria({ kind: 'palette', materiaId: id }, event)} onClick={() => onSelectMateria(selectedMateriaId === id ? undefined : id)} className={`palette-orb ${selectedMateriaId === id ? 'palette-orb-selected' : ''} ${isIterator ? 'palette-orb-iterator' : ''} ${isGenerator ? 'palette-orb-generator' : ''}`}>
              <Orb small color={socketColor(id, index, materia, socket)} label={id} iterator={isIterator} />
              <span className="flex flex-col items-start leading-tight">
                <span>{getSocketLabel(id, socket, materia)}</span>
                {group && <span className="text-[0.62rem] uppercase tracking-[0.2em] text-cyan-200/80">{group}</span>}
                {isIterator && <span className={`materia-iterator-badge palette-iterator-badge ${isGenerator ? 'materia-generator-badge' : ''}`} title={iteratorDetails}>{iteratorBadgeLabel(iteratorDetails)}</span>}
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
