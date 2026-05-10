# WebUI architecture notes

The WebUI refactor keeps the public entry points stable while moving behavior behind small, explicit boundaries. This document records those boundaries so future cleanup does not move business logic back into the compatibility files.

## Frontend boundaries

- `src/webui/client/src/App.tsx` is the browser/test compatibility entry point. It should compose hooks, controllers, and presentation panels, but avoid owning feature business logic directly.
- `src/webui/client/src/webui/api/` is the fetch boundary. API helpers own endpoint paths, HTTP methods, request bodies, and response parsing only; they should not cache, retry, or mutate React state.
- `src/webui/client/src/webui/components/AppShell.tsx` and `src/webui/client/src/webui/hooks/useAppNavigation.ts` own top-level layout and tab URL behavior.
- Feature controllers under `src/webui/client/src/webui/features/**/use*.ts` own local state/actions and receive dependencies explicitly from App or other controllers.
- Feature presentation components render props. They should not fetch, save config, or run graph validation.

## Backend boundaries

- `src/webui/server/index.ts` remains the compatibility facade, server factory, option-normalization point, and CLI direct-run entry.
- `src/webui/server/routes.ts` is the ordered dispatcher. Its `startsWith` route checks and ordering are part of the compatibility surface for the existing WebUI API.
- Route modules (`activeLoadout.ts`, `config.ts`, `health.ts`, `monitor.ts`, and `roleGeneration.ts`) own route-specific validation, status codes, response envelopes, and explicit dependency objects.
- `modelCatalog.ts` owns model catalog normalization and remains re-exported from `index.ts` for existing consumers.
- `http.ts` and `static.ts` contain backend-only Node HTTP/static helpers and should remain side-effect-light.
- `session.ts` contains shared public session/monitor DTO types that are re-exported from `index.ts`; route modules should import these DTOs directly to avoid depending on the facade.
