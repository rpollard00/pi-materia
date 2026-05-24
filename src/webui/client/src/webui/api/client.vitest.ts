import { afterEach, describe, expect, test, vi } from 'vitest';
import { runQuest, runQuestOnce, stopQuestRunner } from './client.js';

function jsonResponse(body: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' }, ...init });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('quest control API client', () => {
  test('posts run and runonce controls with optional quest id payloads', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    await runQuest({ questId: 'quest-1' });
    await runQuestOnce({ questId: 'quest-2' });

    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/quests/run', expect.objectContaining({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ questId: 'quest-1' }),
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/quests/runonce', expect.objectContaining({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ questId: 'quest-2' }),
    }));
  });

  test('posts stop with an empty body and preserves failure envelopes', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: false, error: 'Quest runner control API is unavailable for this server.' }, { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await stopQuestRunner();

    expect(fetchMock).toHaveBeenCalledWith('/api/quests/stop', expect.objectContaining({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    }));
    expect(result.response.status).toBe(503);
    expect(result.body).toEqual({ ok: false, error: 'Quest runner control API is unavailable for this server.' });
  });
});
