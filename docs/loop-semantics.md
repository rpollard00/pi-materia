# Loop semantics and migration

This is the canonical developer reference for generator-driven loop exits.

## Canonical runtime model

Runtime executes only the node-level control fields:

1. `parse` decides whether the node output is parsed as JSON.
2. `assign` copies parsed values into state.
3. `advance` may advance a cursor and return its `done` target.
4. ordered `edges` choose the next socket when `advance` did not finish the consumed list.

`loops.<id>.exit` is declarative loadout intent, not a second router. For generator-consumer loops, pi-materia compiles this intent into the runtime model by materializing the loop exit source node. A loop with both:

```json
"consumes": { "from": "Socket-1", "output": "workItems" },
"exit": { "from": "Socket-4", "when": "satisfied", "to": "end" }
```

materializes the exit source (`Socket-4`) to the equivalent canonical runtime fields:

```json
{
  "parse": "json",
  "advance": {
    "cursor": "workItemIndex",
    "items": "state.workItems",
    "done": "end",
    "when": "satisfied"
  }
}
```

The normal outgoing `edges` remain in place. This is intentional: `advance` runs before edge selection. For non-final items it increments the cursor and falls through to the loop's normal continuation edge; after the final consumed item it returns `advance.done` and bypasses the back-edge.

## Control field

`satisfied` is the canonical boolean control field for `satisfied` / `not_satisfied` routing and for `advance.when`. Nodes that use those conditions must return JSON containing a boolean `satisfied`, and the node must parse JSON. Legacy aliases such as `passed` are not canonical; if any compatibility support exists, treat it as migration-only and do not author new loadouts or materia prompts with those aliases.

## Load/save/run-time compatibility migration

Existing saved UI loadouts such as the historical Yolo loop may contain declarative `loops.exit` and `loops.consumes` but no executable `advance` block. pi-materia repairs those loadouts through the shared loop semantic materializer in the normal configuration paths:

- `loadConfig()` materializes all configured loadouts after layered config merge, so saved user/profile/project loadouts are executable without manual edits.
- `saveMateriaConfigPatch()` materializes before persisting WebUI/config patches, so newly saved UI loadouts store the canonical fields.
- `resolvePipeline()` materializes the active loadout again before validation and runtime resolution, so direct in-memory configs and older files loaded by other paths receive the same behavior.
- the WebUI save normalization calls the same materializer, keeping editor output, saved config, and runtime behavior aligned.

Materialization is defensive and idempotent. It fills only missing compatible fields. It preserves hand-authored `parse: "json"` and matching `advance` definitions. It reports conflicts instead of silently overwriting authored behavior, for example when an exit source explicitly has `parse: "text"` while `exit.when: "satisfied"` requires JSON, or when an existing `advance.cursor`, `items`, `done`, or `when` differs from the value derived from `loops.consumes` plus `loops.exit`.

## Simple Build → Maintain loop

A UI-authored loop may be saved with only the declarative region and an unconditional back-edge:

```json
{
  "entry": "Socket-1",
  "nodes": {
    "Socket-1": { "type": "agent", "materia": "planner", "edges": [{ "when": "always", "to": "Socket-3" }] },
    "Socket-3": { "type": "agent", "materia": "Build", "edges": [{ "when": "always", "to": "Socket-4" }] },
    "Socket-4": { "type": "agent", "materia": "Maintain", "edges": [{ "when": "always", "to": "Socket-3" }] }
  },
  "loops": {
    "workItemIteration": {
      "nodes": ["Socket-3", "Socket-4"],
      "consumes": { "from": "Socket-1", "output": "workItems" },
      "exit": { "from": "Socket-4", "when": "satisfied", "to": "end" }
    }
  }
}
```

At load/save/run time, `Socket-1` is normalized as a generator socket (`parse: "json"`, `assign.workItems: "$.workItems"`) and `Socket-4` is materialized with JSON parsing and `advance` over `state.workItems`. If Maintain returns `{ "satisfied": false }`, `advance.when` does not run and the `always` edge retries the current item. If Maintain returns `{ "satisfied": true }`, the cursor advances; non-final items continue to `Socket-3`, and the final item exits to `end`.

## Rich Build → Auto-Eval → Maintain loop

A richer loop keeps explicit retry routing and still uses the same exit materialization:

```json
{
  "nodes": {
    "Socket-1": { "type": "agent", "materia": "planner", "edges": [{ "when": "always", "to": "Socket-4" }] },
    "Socket-4": { "type": "agent", "materia": "Build", "edges": [{ "when": "always", "to": "Socket-5" }] },
    "Socket-5": {
      "type": "agent",
      "materia": "Auto-Eval",
      "parse": "json",
      "edges": [
        { "when": "not_satisfied", "to": "Socket-4" },
        { "when": "satisfied", "to": "Socket-6" }
      ]
    },
    "Socket-6": {
      "type": "agent",
      "materia": "Maintain",
      "edges": [
        { "when": "not_satisfied", "to": "Socket-6", "maxTraversals": 3 },
        { "when": "always", "to": "Socket-4" }
      ]
    }
  },
  "loops": {
    "workItemIteration": {
      "nodes": ["Socket-4", "Socket-5", "Socket-6"],
      "consumes": { "from": "Socket-1", "output": "workItems" },
      "exit": { "from": "Socket-6", "when": "satisfied", "to": "end" }
    }
  }
}
```

`Socket-6` receives the derived `advance` block. Its explicit `not_satisfied` retry edge is preserved, and its `always` edge remains the normal continuation route for the next work item after successful non-final maintenance.
