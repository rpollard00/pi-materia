import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ParallelismSettingsPanel } from './ParallelismSettingsPanel.js';

afterEach(cleanup);

describe('ParallelismSettingsPanel', () => {
  it('edits only a positive app-level concurrency bound', () => {
    const onChange = vi.fn();
    render(<ParallelismSettingsPanel maxConcurrency={3} onChange={onChange} />);
    const input = screen.getByTestId('app-parallel-max-concurrency') as HTMLInputElement;
    expect(input.value).toBe('3');
    fireEvent.change(input, { target: { value: '5' } });
    expect(onChange).toHaveBeenCalledWith(5);
    fireEvent.change(input, { target: { value: '0' } });
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});
