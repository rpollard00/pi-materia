import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { useState } from 'react';
import { emptyMateriaForm } from '../../utils/forms.js';
import type { MateriaFormState } from '../../types.js';
import { MateriaEditorSettingsSection } from './MateriaEditorSettingsSection.js';

function Probe() {
  const [materiaForm, setMateriaForm] = useState<MateriaFormState>(emptyMateriaForm());
  return <MateriaEditorSettingsSection
    form={{ materiaForm, setMateriaForm, handleMateriaModelChange: () => {} } as never}
    modelOptions={{ modelOptions: [{ value: '', label: 'Active' }], thinkingOptions: [{ value: '', label: 'Active' }], modelCatalog: { models: [] }, modelCatalogStatus: 'ready', modelCatalogError: '', thinkingLevelsForSelection: [] } as never}
    colorPicker={{ materiaColorOpen: false, setMateriaColorOpen: () => {}, materiaColorDropdownRef: { current: null } } as never}
  />;
}

afterEach(cleanup);

describe('MateriaEditorSettingsSection parallel generation', () => {
  it('enables parallel generation only for generators and clears it when generator is disabled', () => {
    render(<Probe />);
    const generator = screen.getByTestId('materia-generator') as HTMLInputElement;
    const parallel = screen.getByTestId('materia-parallel') as HTMLInputElement;

    expect(parallel.disabled).toBe(true);
    fireEvent.click(generator);
    expect(parallel.disabled).toBe(false);
    fireEvent.click(parallel);
    expect(parallel.checked).toBe(true);
    fireEvent.click(generator);
    expect(parallel.disabled).toBe(true);
    expect(parallel.checked).toBe(false);
  });
});
