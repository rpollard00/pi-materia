import { materiaColorChoices } from '../../../loadoutModel.js';
import { Orb } from '../../components/Orb.js';
import type { MateriaEditorController } from './useMateriaEditorController.js';

interface ColorPickerFieldProps {
  form: MateriaEditorController['form'];
  colorPicker: MateriaEditorController['colorPicker'];
}

export function ColorPickerField({ form, colorPicker }: ColorPickerFieldProps) {
  const { materiaForm, setMateriaForm } = form;
  const { materiaColorDropdownRef, materiaColorOpen, setMateriaColorOpen } = colorPicker;

  return (
    <fieldset ref={materiaColorDropdownRef} className="graph-field materia-color-picker" data-testid="materia-color" aria-label="Color">
    <legend>Color</legend>
    <div className="materia-color-dropdown">
      <button type="button" className="materia-color-trigger" aria-haspopup="listbox" aria-expanded={materiaColorOpen} aria-controls="materia-color-options" aria-label="Select materia color" data-testid="materia-color-trigger" onClick={() => setMateriaColorOpen((open) => !open)}>
        <Orb small color={materiaForm.color} label="Selected materia color" />
        <span aria-hidden className="materia-color-trigger-caret">▾</span>
      </button>
      {materiaColorOpen && (
        <div id="materia-color-options" className="materia-color-options" role="listbox" aria-label="Materia color choices">
          {materiaColorChoices.map((choice) => {
            const selected = materiaForm.color === choice.value;
            return (
              <button key={choice.id} type="button" role="option" aria-selected={selected} aria-label={`${choice.label} materia color`} data-testid={`materia-color-${choice.id}`} className={`materia-color-option ${selected ? 'materia-color-option-selected' : ''}`} onClick={() => { setMateriaForm({ ...materiaForm, color: choice.value }); setMateriaColorOpen(false); }} title={`${choice.label} materia color`}>
                <Orb small color={choice.value} label={`${choice.label} materia color`} />
              </button>
            );
          })}
        </div>
      )}
    </div>
    {materiaForm.color && !materiaColorChoices.some((choice) => choice.value === materiaForm.color) && <p className="materia-color-legacy">Legacy custom color is selected; choose a palette color to replace it.</p>}
    </fieldset>
  );
}
