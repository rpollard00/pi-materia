# Loop semantics and migration

This is the developer reference for current generator-driven loop exits and migration behavior. The normative structured loop contract is [Structured loop semantics](structured-loop-semantics.md). The compatibility shim inventory and removal plan are in [Loop compatibility and sunset plan](loop-compatibility-sunset.md). The structured contract makes `advance` cursor advancement/exhaustion detection only, makes `loops.<id>.exits` the canonical post-exhaustion route owner, and keeps `end` as the only graph/loadout terminal sentinel.

## Current runtime model

Current runtime executes only the socket-level control fields:

1. `parse` decides whether the socket output is parsed as JSON.
2. `assign` copies parsed values into state.
3. `advance` may advance a cursor and detect exhaustion. When exhaustion occurs, runtime resolves loop-owned post-exhaustion routing before considering any named legacy fallback.
4. ordered `edges` choose the next socket for same-item/non-exhausted control flow.

`loops.<id>.exits` is canonical post-exhaustion routing metadata. Legacy `loops.<id>.exit` is declarative/descriptive compatibility input that may be normalized into `loops.<id>.exits` when it points at a socket. For generator-consumer loops, pi-materia also materializes compatible cursor-advance fields on the loop exit source socket. A legacy loop with both:

```json
"consumes": { "from": "Socket-1", "output": "workItems" },
"exit": { "from": "Socket-4", "when": "satisfied", "to": "end" }
```

materializes the exit source (`Socket-4`) to compatible runtime fields:

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

The normal outgoing `edges` remain in place. This is intentional: `advance` runs before edge selection. For non-final items it increments the cursor and falls through to the loop's normal continuation edge; after the final consumed item runtime resolves `loops.<id>.exits` and falls back to terminal `end` when no route matches. Any legacy `advance.done` fallback is isolated behind named compatibility helpers and is not the canonical post-loop route.

New authoring should express socket-valued post-exhaustion routing through `loops.<id>.exits`; a loop with no matching exit route falls through to terminal `end`.

## Control field

`satisfied` is the canonical boolean control field for `satisfied` / `not_satisfied` routing and for `advance.when`. Sockets that use those conditions must return JSON containing a boolean `satisfied`, and the socket must parse JSON. Legacy aliases such as `passed` are not canonical; if any compatibility support exists, treat it as migration-only and do not author new loadouts or materia prompts with those aliases.

## Load/save/run-time compatibility migration

Existing saved UI loadouts such as the historical Yolo loop may contain declarative `loops.exit` and `loops.consumes` but no executable `advance` block. pi-materia repairs those loadouts through the shared loop semantic materializer in the normal configuration paths:

- `loadConfig()` materializes all configured loadouts after layered config merge, so saved user/profile/project loadouts are executable without manual edits.
- `saveMateriaConfigPatch()` materializes before persisting WebUI/config patches, so newly saved UI loadouts store the canonical fields.
- `resolvePipeline()` materializes the active loadout again before validation and runtime resolution, so direct in-memory configs and older files loaded by other paths receive the same behavior.
- the WebUI save normalization calls the same materializer, keeping editor output, saved config, and runtime behavior aligned.

Materialization and compatibility normalization are defensive and idempotent. They fill only missing compatible fields and mirror socket-valued legacy `loop.exit.to` / loop-member `advance.done` routes into `loops.<id>.exits` on prepared clones. They preserve hand-authored `parse: "json"` and matching `advance` definitions. They report conflicts instead of silently overwriting authored behavior, for example when an exit source explicitly has `parse: "text"` while `exit.when: "satisfied"` requires JSON, or when existing cursor/items/when fields conflict with the consumed iterator. Terminal `advance.done: "end"` is accepted as migration compatibility but new-model configs use the default no-route fallback to `end`.

## Simple Build → Maintain loop

A UI-authored loop may be saved with only the declarative region and an unconditional back-edge:

```json
{
  "entry": "Socket-1",
  "sockets": {
    "Socket-1": { "type": "agent", "materia": "planner", "edges": [{ "when": "always", "to": "Socket-3" }] },
    "Socket-3": { "type": "agent", "materia": "Build", "edges": [{ "when": "always", "to": "Socket-4" }] },
    "Socket-4": { "type": "agent", "materia": "Maintain", "edges": [{ "when": "always", "to": "Socket-3" }] }
  },
  "loops": {
    "workItemIteration": {
      "sockets": ["Socket-3", "Socket-4"],
      "consumes": { "from": "Socket-1", "output": "workItems" },
      "exit": { "from": "Socket-4", "when": "satisfied", "to": "end" }
    }
  }
}
```

At load/save/run time, `Socket-1` is normalized as a generator socket (`parse: "json"`, `assign.workItems: "$.workItems"`) and `Socket-4` is materialized with JSON parsing and `advance` over `state.workItems`. If Maintain returns `{ "satisfied": false }`, `advance.when` does not run and the `always` edge retries the current item. If Maintain returns `{ "satisfied": true }`, the cursor advances; non-final items continue to `Socket-3`, and final-item exhaustion resolves loop exits before falling back to `end`. This terminal result is the default no-exit fallback, not a requirement to author post-loop routing in `advance.done`.

## Rich Build → Auto-Eval → Maintain loop

A richer loop keeps explicit retry routing and still uses the same exit materialization:

```json
{
  "sockets": {
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
      "sockets": ["Socket-4", "Socket-5", "Socket-6"],
      "consumes": { "from": "Socket-1", "output": "workItems" },
      "exit": { "from": "Socket-6", "when": "satisfied", "to": "end" }
    }
  }
}
```

`Socket-6` receives the derived `advance` block. Its explicit `not_satisfied` retry edge is preserved, and its `always` edge remains the normal continuation route for the next work item after successful non-final maintenance.
