# Materia WebUI smoke tests

Use these checks after changing the WebUI, launcher, config persistence, or pipeline editor.

## Prerequisites

```bash
npm run typecheck
npm test
npm run test:webui
npm run build:webui
```

Run Pi with this extension from a disposable target repository:

```bash
cd /path/to/target-project
PI_MATERIA_PROFILE_DIR=$(mktemp -d) pi -e /path/to/pi-materia/src/index.ts
```

## `/materia ui` lifecycle

1. Run `/materia ui`.
2. Confirm the Pi session remains usable immediately; the command should not wait for idle, start a cast, or hijack input.
3. Confirm Pi shows a clickable `http://127.0.0.1:<port>/?session=<key>` URL and a `materia-webui` widget.
4. Run `/materia ui` again in the same Pi session and confirm it reports that the existing session-scoped server was reused.
5. Optional browser-open check: write `{ "webui": { "autoOpenBrowser": true } }` to `$PI_MATERIA_PROFILE_DIR/config.json`, restart Pi, run `/materia ui`, and confirm the browser opens.

## Loadout grid editor

1. Open the URL from `/materia ui`.
2. Switch between `Full-Auto` and `Planning-Consult`; confirm changes are staged and not saved until `Save`.
3. Drag a palette materia into an existing socket, drag an occupied socket to another socket, and drag a materia to the removal target.
4. Save to `user` scope and confirm `.pi/pi-materia.json` in the project was not modified unless `project` scope was explicitly selected.

## Materia creation/editing

1. Create a prompt materia with name, prompt text, model, JSON output format, and multiturn enabled.
2. Save with the default `user` target and confirm it appears in `$PI_MATERIA_PROFILE_DIR/materia.json`.
3. Create a tool/utility materia and explicitly choose `project`; confirm it is written to `.pi/pi-materia.json`.
4. Edit an existing prompt materia and confirm graph links, layout, and inserted metadata on the socket are preserved.

## Role prompt generator

1. In the materia editor, type existing text into the prompt field and enter a concise role brief in **Generate role prompt from brief**.
2. Click **Generate** and confirm the button enters a loading state, then a generated preview appears without changing the prompt field.
3. Click **Regenerate** and confirm the preview updates while the prompt field still keeps its original text.
4. Click **Discard** and confirm the preview is removed and the prompt field remains unchanged.
5. Generate again, then click **Apply to prompt field** and confirm only this explicit action replaces the prompt field with the preview.
6. Save only if you want to persist the applied prompt; generation/preview/discard alone should not write user or project config.

## Pipeline graph editor

1. Add a new node and save; confirm existing nodes keep their previous layout.
2. Insert a node between two connected nodes and confirm the surrounding `next`/edge path is rewired through the inserted node.
3. Add or change `satisfied` and `not_satisfied` branches.
4. Tweak retry/visit limits and save; confirm unrelated graph metadata such as `insertedBy`, `inserted`, and `layout` remains intact.

## Graph layout regression checks

These complement the automated WebUI tests for graph sizing, routing, and drag/drop behavior.

1. Open a loadout with at least six sockets without explicit `layout` values; confirm they use two columns in serpentine order (`left→right`, then `right→left`) and the page itself does not gain horizontal scroll.
2. Open or create a loadout with many explicit wide coordinates; confirm the graph canvas scrolls inside the visual grid viewport while surrounding WebUI panels stay usable.
3. Confirm the socket cards and materia orbs look compact but labels remain readable and socket/orb drag targets are still practical.
4. Inspect same-row, row-transition, back, and self-loop edges; arrowheads should align to the final edge segment and point into the target socket side, including top/bottom anchors for vertical transitions.
5. Drag an occupied socket's orb onto the graph background; confirm the socket becomes empty immediately, graph links/layout remain intact, and saving persists the empty socket.

## Session monitoring

1. Start a short `/materia cast` from the same Pi session that launched the UI.
2. Confirm the monitor panel shows emitted outputs, elapsed time, artifact summary text, and recent artifact contents.
3. Confirm the graph highlights the currently active node.
4. Open a second independent Pi session and verify this WebUI does not aggregate outputs from that other session.
