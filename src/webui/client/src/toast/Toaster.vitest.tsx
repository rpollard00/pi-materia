import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Toaster } from './Toaster.js';
import { dispatchMateriaToast, resetToastStoreForTests, toast } from './store.js';

function toastArticleForText(text: string) {
  const element = screen.getByText(text);
  const article = element.closest('article');
  if (!article) throw new Error(`Missing toast article for ${text}`);
  return article;
}

afterEach(() => {
  cleanup();
  resetToastStoreForTests();
  vi.useRealTimers();
});

describe('Toaster', () => {
  it('renders materia:toast CustomEvent payloads with title, description, and variant markers', async () => {
    render(<Toaster />);

    dispatchMateriaToast({
      id: 'bridge-warning',
      title: 'Bridge warning',
      description: 'Dispatched from a CustomEvent.',
      variant: 'warning',
    });

    expect(await screen.findByText('Bridge warning')).toBeTruthy();
    expect(screen.getByText('Dispatched from a CustomEvent.')).toBeTruthy();
    const article = toastArticleForText('Bridge warning');
    expect(article.getAttribute('data-toast-variant')).toBe('warning');
    expect(article.classList.contains('materia-toast--warning')).toBe(true);
    expect(article.getAttribute('role')).toBe('status');
  });

  it('keeps validation and error toasts persistent by default while auto-dismissing success/info or configured durations', async () => {
    vi.useFakeTimers();
    render(<Toaster />);

    act(() => {
      toast({ id: 'validation-default', title: 'Validation stays', variant: 'validation' });
      toast({ id: 'error-default', title: 'Error stays', variant: 'error' });
      toast({ id: 'error-configured', title: 'Error can time out', variant: 'error', durationMs: 25 });
      toast({ id: 'success-default', title: 'Success leaves', variant: 'success' });
      toast({ id: 'info-default', title: 'Info leaves', variant: 'info' });
    });

    expect(screen.getByText('Validation stays')).toBeTruthy();
    expect(screen.getByText('Error stays')).toBeTruthy();
    expect(screen.getByText('Error can time out')).toBeTruthy();
    expect(screen.getByText('Success leaves')).toBeTruthy();
    expect(screen.getByText('Info leaves')).toBeTruthy();

    await act(async () => {
      vi.advanceTimersByTime(25);
    });
    expect(screen.queryByText('Error can time out')).toBeNull();
    expect(screen.getByText('Validation stays')).toBeTruthy();
    expect(screen.getByText('Error stays')).toBeTruthy();
    expect(screen.getByText('Success leaves')).toBeTruthy();
    expect(screen.getByText('Info leaves')).toBeTruthy();

    await act(async () => {
      vi.advanceTimersByTime(4_975);
    });
    expect(screen.queryByText('Success leaves')).toBeNull();
    expect(screen.queryByText('Info leaves')).toBeNull();
    expect(screen.getByText('Validation stays')).toBeTruthy();
    expect(screen.getByText('Error stays')).toBeTruthy();
  });

  it('supports manual dismissal and replaces existing toasts by id', async () => {
    render(<Toaster />);

    act(() => {
      toast({ id: 'replace-me', title: 'Original title', description: 'Original body', variant: 'info' });
      toast({ id: 'replace-me', title: 'Updated title', description: 'Updated body', variant: 'error' });
    });

    expect(screen.queryByText('Original title')).toBeNull();
    expect(screen.queryByText('Original body')).toBeNull();
    expect(screen.getByText('Updated title')).toBeTruthy();
    expect(screen.getByText('Updated body')).toBeTruthy();
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(toastArticleForText('Updated title').getAttribute('data-toast-variant')).toBe('error');

    fireEvent.click(screen.getByRole('button', { name: /dismiss notification: updated title/i }));

    await waitFor(() => expect(screen.queryByText('Updated title')).toBeNull());
  });
});
