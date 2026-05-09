# WebUI refactor audit

This audit maps the current frontend WebUI structure before any extraction work. It is intentionally documentation-only and does not change runtime behavior.

## Current entry points and large files

- `src/webui/client/src/main.tsx` mounts React and renders `<App />`.
- `src/webui/client/src/App.tsx` is the monolithic WebUI entry/component. At audit time it is about 2,887 lines and contains:
  - local WebUI types and constants,
  - pure formatting/parsing/layout helpers,
  - API fetch helpers,
  - the full `App` state/effect orchestration,
  - all major tab JSX and shared controls.
- `src/webui/client/src/loadoutModel.ts` already contains reusable loadout/domain helpers and is covered by focused tests. It should remain a domain model dependency rather than absorbing React UI code.

## Major UI regions in `App.tsx`

- App shell/header/tab navigation: page chrome, source/status badge, and `materiaTabs` tab switching.
- Loadout tab:
  - loadout selector sidebar with create/rename/delete/switch actions,
  - visual graph canvas with SVG edges, loop regions, socket cards, drag/drop, region selection, and socket layout drag,
  - loop editor panel for loop exits and breaking loops,
  - socket action modal with replace/edit/connect/delete/edge-removal flows,
  - materia palette sidebar,
  - stage/apply panel with save target, trash drop target, save/revert/status controls.
- Materia Editor tab:
  - reusable materia settings form,
  - model/thinking selectors and model catalog status,
  - color picker,
  - prompt/tool-specific fields,
  - role prompt generation preview/apply/discard flow,
  - materia save/clear controls.
- Monitor tab:
  - active cast stats,
  - emitted outputs,
  - artifact summary,
  - recent artifacts.
- Shared controls currently embedded in `App.tsx`: `Orb`, tab buttons, graph-field inputs/selects, socket modal rows/buttons, monitor cards, color picker options, palette rows, loadout cards.

## Code classification

### Shared/local types and constants

Currently in `App.tsx` near the top:

- UI state/API types: `SaveTarget`, `MateriaFormState`, `SocketPropertyFormState`, `LoadoutSourceScope`, `ConfigResponse`, `RoleGenerationResponse`, `ModelCatalogModel`, `ModelCatalogResponse`, `ModelCatalogLoadState`, `OriginalMateriaModelSettings`, `SelectOption`, `MateriaSavedEventDetail`, `MonitorSnapshot`, `DragPayload`.
- Graph/rendering types: `LoadoutEdge`, `PositionedSocket`, `RoutedLoadoutEdge`, `LoopRegion`, `LoopMembership`, `LoopExitBadge`, `SocketAnchorSide`, `SocketAnchorPoint`, drag state types.
- Constants: tab definitions, event names, active model/thinking labels, thinking labels, socket graph dimensions, loop accent palette, edge condition labels.

Good first extraction target: `src/webui/client/src/webui/types.ts` and feature-local graph types where possible. Keep graph layout types close to graph helpers until consumers are known.

### Pure helper logic

Pure or mostly pure helpers in `App.tsx` include:

- tab parsing: `parseTabId`, `tabFromLocation` (browser-dependent only through `window` guard),
- empty form factories and cloning: `emptyMateriaForm`, `emptySocketPropertyForm`, `cloneConfig`,
- loadout/edge/iterator/generator formatting: `buildLoadouts`, edge condition helpers, generator/iterator labels, loop summaries, socket hover details,
- graph layout/routing: `getLoadoutEdges`, layout math, intersection/routing helpers, `routeLoadoutEdges`, automatic socket ordering, loop region/membership/badge derivation, `layoutSockets`,
- parsing/normalization: drag payload JSON parsing, command splitting, optional numeric parsing,
- model catalog normalization/options: `emptyModelCatalog`, record/string guards, thinking normalization, catalog normalization/deduping/select-option helpers,
- materia patch creation: `canonicalWorkItemsGeneratorConfig`, `buildMateriaPatch`,
- display helpers: `materiaColorClass`, `formatElapsed`, `formatTime`.

Extraction boundary recommendation:

- `webui/constants.ts` for tab labels, event names, model/thinking labels, graph dimensions if shared.
- `webui/utils/modelCatalog.ts` for catalog normalization and select-option helpers.
- `webui/utils/graphLayout.ts` for socket positioning, routing, loop regions, memberships, exit badges.
- `webui/utils/forms.ts` or feature-local modules for empty form factories and form-to-config parsing.
- Avoid one broad `utils.ts`; keep graph layout, model catalog, form parsing, and display formatting separate.

### API/effect logic

Effectful code currently lives inside `App` or near it:

- initial config load through `reloadConfig()` / `fetchMateriaConfig()` with demo fallback,
- config save through `/api/config` for loadout drafts and materia definitions,
- monitor polling/EventSource through `/api/monitor` and `/api/monitor/events`,
- lazy model catalog load through `/api/models` when the Materia Editor tab opens,
- role prompt generation through `/api/generate/materia-role`,
- window events: `popstate`, `materia:saved`, outside-click/Escape handling for the color picker.

Extraction boundary recommendation:

- Keep these effects in `App.tsx` during the first presentational component split.
- Later hook candidates: `useWebuiConfig`, `useMonitorSnapshot`, `useModelCatalog`, and possibly `useMateriaSavedReload` once component boundaries are stable.

### Local mutation/editing logic

`App` owns substantial draft mutation behavior:

- draft config updates via `updateDraft`, `reloadConfig`, `saveDraft`, revert, dirty detection,
- loadout lifecycle: switch, create, rename, delete, save deletion markers/source scope,
- socket/materia mutation: place/swap/remove materia, delete sockets, create connected sockets,
- graph mutation: validated edge create/remove/toggle, legacy next removal, socket property save,
- loop editing: selection, drag-region selection, create task iterator loop, update/clear/break loop,
- socket layout drag and layout coordinate persistence,
- materia form editing/saving, model/thinking preservation, generator config, utility definition creation,
- role prompt generation preview state.

Extraction boundary recommendation:

- Do not move this logic until presentational boundaries are extracted and behavior tests are passing.
- Later reducer/hook candidates: `useLoadoutDraft` or `loadoutDraftReducer`, `useSocketGraphEditing`, `useLoopEditing`, and `useMateriaDefinitionForm`.

## Proposed component/module boundaries

Suggested incremental shape for follow-on work:

```text
src/webui/client/src/webui/
  types.ts
  constants.ts
  utils/
    display.ts
    graphLayout.ts
    modelCatalog.ts
    formParsing.ts
  components/
    Orb.tsx
    TabBar.tsx
    StatusHeader.tsx
  features/
    loadout/
      LoadoutWorkspace.tsx
      LoadoutSidebar.tsx
      LoadoutGraph.tsx
      LoopEditorPanel.tsx
      SocketActionModal.tsx
      MateriaPalette.tsx
      StageApplyPanel.tsx
    materia-editor/
      MateriaEditorPanel.tsx
      MateriaSettingsForm.tsx
      ModelThinkingFields.tsx
      MateriaColorPicker.tsx
      RolePromptGenerator.tsx
    monitor/
      MonitorPanel.tsx
      MonitorCard.tsx
  hooks/              # only after component extraction stabilizes
    useWebuiConfig.ts
    useModelCatalog.ts
    useMonitorSnapshot.ts
```

Dependency direction should remain one-way: shared types/constants/helpers must not import React components; feature components receive orchestration state/callbacks as explicit props; hooks should encapsulate one stable effect/data lifecycle rather than replacing the monolith with a hook monolith.

## Existing validation commands

Confirmed in `package.json`:

- `npm run test:webui` → `vitest run --config src/webui/client/vitest.config.ts`
- `npm run typecheck` → root TypeScript check plus WebUI client and server checks
- Other related commands: `npm run build:webui`, `npm run dev:webui`, `npm run dev:webui:server`

## Current test coverage and risk notes

Observed frontend tests:

- `src/webui/client/src/App.vitest.tsx` has broad integration-style coverage for loadout editing, graph layout/routing, loops, socket actions, drag/drop, tab routing, materia editor, model/thinking fields, role prompt generation, tool materia, and monitor rendering.
- `src/webui/client/src/App.vitest.ts` covers exported loop label helpers.
- `src/webui/client/src/loadoutModel.vitest.ts` covers loadout normalization, deletion, display labels, colors, palette derivation, placement, and socket ids.
- `src/webui/client/src/modelCatalog.vitest.ts` covers `modelSelectOptions` behavior.

Risk areas for extraction:

- Many tests import helpers from `App.tsx`, so pure-helper extraction will require careful import updates or temporary re-exports.
- The integration tests are extensive but coupled to current test ids/classes and monolithic component behavior; preserve DOM structure/classes during component extraction.
- Effect timing for config load, monitor EventSource fallback, model catalog lazy loading, and `materia:saved` reload should not be moved until hooks are intentionally introduced.
- Drag/drop and pointer interactions for socket layout and region selection are high-risk because they rely on browser event details and local mutable UI state.
- Role generation and materia form model/thinking preservation have coverage, but state is intertwined with save/reload behavior and should be split conservatively.
