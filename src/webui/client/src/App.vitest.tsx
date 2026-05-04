import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { App } from './App.js';

describe('Materia WebUI scaffold', () => {
  it('renders the loadout grid placeholder', () => {
    render(<App />);

    expect(screen.getByRole('heading', { name: 'Materia WebUI' })).toBeTruthy();
    expect(screen.getByText('Loadout grid')).toBeTruthy();
  });
});
