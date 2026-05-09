import { materiaColorClass } from '../utils/display.js';

export interface OrbProps {
  color: string;
  label: string;
  small?: boolean;
  empty?: boolean;
  iterator?: boolean;
}

export function Orb({ color, label, small = false, empty = false, iterator = false }: OrbProps) {
  return <div aria-hidden className={`${small ? 'materia-orb-small' : 'materia-orb'} ${empty ? 'materia-orb-empty' : materiaColorClass(color)} ${iterator && !empty ? 'materia-orb-iterator' : ''}`} title={label} />;
}
