// Node 26 exposes an experimental global localStorage. Vitest's jsdom
// environment skips that name while copying window globals, so restore jsdom's
// origin-backed storage for tests that exercise the browser persistence layer.
const jsdomWindow = (globalThis as typeof globalThis & { jsdom?: { window?: Window } }).jsdom?.window;

if (typeof window !== 'undefined' && !window.localStorage && jsdomWindow?.localStorage) {
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: jsdomWindow.localStorage,
  });
}
