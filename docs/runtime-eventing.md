# Runtime Eventing Contract

**Status**: Draft design contract (implementation not started)

This document defines the pi-materia runtime eventing system — a generic, configurable
internal event bus with optional webhook delivery. It is written as a shared design
contract before any implementation begins. All subsequent work items should start by
reading this document.

## 1. Design Philosophy

The eventing system is **generic** and **configuration-driven**. It is not specific to
any particular controller, orchestrator, or external system. The agent_router (agent
controller) is one supported integration target reached through a preset/configuration,
not through hard-coded logic.

The system supports two event sources:

1. **Materia-emitted events** — structured event arrays written by agents and utilities
   through a reserved JSON side-channel field.
2. **Runtime-owned lifecycle events** — cast start, socket start/complete, heartbeats,
   failures, and terminal events emitted by pi-materia itself.

All events flow through the same internal bus, filtering, enrichment, dispatch, and
local artifact recording pipeline.

## 2. Reserved Side-Channel Field: `event`

### 2.1 Declaration

The reserved JSON side-channel field is exactly `event`. It is **always an array of
event objects** when present:

```json
{
  "workItems": [
    { "title": "feat: implement retry logic", "context": "Add retry handling for 5xx errors." }
  ],
  "satisfied": true,
  "context": "Implementation complete. PR opened at https://github.com/org/repo/pull/42.",
  "event": [
    {
      "type": "result.pr_created",
      "message": "PR #42 created for retry handling",
      "payload": {
        "prUrl": "https://github.com/org/repo/pull/42",
        "branchName": "agent/42-add-retry",
        "baseBranch": "main"
      }
    }
  ]
}
```

### 2.2 Field Rules

| Rule | Detail |
|------|--------|
| **Field name** | Exactly `event` (lowercase). No aliases. |
| **Top-level only** | The `event` field lives at the top level of the JSON handoff object. It is never nested inside `state`, `payload`, or any other envelope field. |
| **Must be an array** | When present, `event` must be an array. An object, string, or other non-array value is a validation failure. |
| **Empty arrays allowed** | `"event": []` is legal and treated as a no-op (no events to process). |
| **Each element must be an object** | Every element of the `event` array must be a plain object with at least a `type` field. |
| **Not part of the agent handoff contract** | `event` is a side-channel read by the runtime before handoff semantics run. Agents and utilities are told they may emit events but events are stripped before handoff validation, routing, assignment, state mutation, and downstream prompt context assembly. |

### 2.3 Event Object Shape (Materia-Emitted)

Each event object in the `event` array has this minimal shape:

```ts
interface MateriaEventObject {
  type: string;                   // required — dot-separated event kind (e.g. "result.pr_created", "status.progress")
  severity?: "debug" | "info" | "warning" | "error" | "critical";  // default "info"
  message?: string;               // human-readable summary
  payload?: Record<string, unknown>; // type-specific data
  source?: {                      // optional provenance
    materia?: string;
    socketId?: string;
  };
}
```

- `type` is required. Every event must have a non-empty type string. Convention uses
  dot-separated namespaced types: `result.pr_created`, `status.progress`,
  `error.validation_failed`, etc.
- `severity` defaults to `"info"` when omitted.
- `message` is a human-readable status or summary string.
- `payload` is an arbitrary key/value map. Content is type-specific.
- `source` is optional provenance that the materia may self-report. The runtime adds
  authoritative metadata during enrichment regardless of whether source is present.

### 2.4 Invalid `event` Handling

| Scenario | Agent socket | Utility socket |
|----------|-------------|----------------|
| `event` is present but not an array | Treated as invalid JSON output — triggers existing JSON repair/retry flow | Hard failure — utility output is invalid; socket/cast fails |
| `event` element is not a plain object | Same as above | Same as above |
| `event` element is missing `type` | Same as above | Same as above |
| `event` element has extra unknown fields | Allowed (forward-compatible); unknown fields are preserved in enrichment and recording but do not affect dispatch | |

### 2.5 Text Sockets

Plain text sockets (`"parse": "text"`) do not produce JSON output and therefore cannot
emit side-channel events. Event emission is a JSON-side-channel capability only. This
is documented in synthetic context instructions given to JSON-output materia.

## 3. Event Processing Pipeline

Events are processed **immediately after JSON parse**, before any handoff semantics run.
The pipeline is:

```
JSON parse → extract event → validate event → enrich → dispatch → strip event → handoff
```

### 3.1 Extract

After a JSON socket (agent or utility) produces valid parsed output, the runtime
extracts the top-level `event` field. If the field is absent or an empty array, the
pipeline is a no-op.

### 3.2 Validate

Each event object in the array is validated:

- Must be a plain object.
- Must have a non-empty string `type`.
- `severity` (if present) must be one of `debug`, `info`, `warning`, `error`, `critical`.
- `message` (if present) must be a string.
- `payload` (if present) must be a plain object.

For agent sockets, validation failures trigger existing JSON repair/retry behavior
(same as any other invalid JSON output field). For utility sockets, validation failures
are hard failures — the utility produced invalid structured output.

### 3.3 Enrich

Each validated event object is enriched with runtime metadata:

```ts
interface EnrichedEvent {
  // Original materia-emitted fields
  type: string;
  severity: "debug" | "info" | "warning" | "error" | "critical";
  message?: string;
  payload?: Record<string, unknown>;
  source?: {
    materia?: string;
    socketId?: string;
  };

  // Runtime-enriched fields
  eventId: string;           // unique per-event id (uuid)
  occurredAt: string;        // ISO 8601 timestamp
  sequence: number;          // monotonic per-cast sequence (1-based)
  castId: string;            // current cast identifier
  socketId: string;          // socket that produced this event
  materia: string;           // materia id
  materiaLabel?: string;     // materia display label
  visit: number;             // socket visit counter
  itemKey?: string;          // current work item key (when in a loop region)
  itemLabel?: string;        // current work item label (when in a loop region)
}
```

Enrichment is deterministic and preserves input array order. The monotonic per-cast
sequence is shared across all event sources (materia-emitted and runtime-owned) to
ensure total ordering.

### 3.4 Dispatch

Enriched events are dispatched to the internal event bus. The bus delivers each event
to all configured sinks (see §4). Dispatch is **best-effort and non-blocking**: a sink
failure does not abort the cast or prevent downstream handoff.

### 3.5 Strip

After dispatch, the `event` field is **completely removed** from the parsed JSON before
any handoff semantics run. This ensures:

- `event` does not leak into handoff validation (`workItems`, `satisfied`, `context`).
- `event` does not leak into work item assignment or cast state.
- `event` does not leak into graph routing or advancement decisions.
- `event` does not leak into utility state patches (`state.*`).
- `event` does not leak into downstream synthetic prompt context.
- `event` is not available to downstream sockets through `lastJson` or state.

The only record of events is through the explicit event bus artifacts (§5).

## 4. Event Bus and Sinks

### 4.1 Architecture

```
                  ┌─────────────┐
  Materia events  │             │   ┌──────────┐
  ───────────────►│             │──►│  Sink 1  │  (webhook)
                  │  Event Bus  │   └──────────┘
  Lifecycle       │             │   ┌──────────┐
  events ────────►│             │──►│  Sink 2  │  (local recording)
                  └─────────────┘   └──────────┘
```

The event bus is an internal dispatch mechanism. It does not persist events directly —
each sink decides what to do with delivered events.

### 4.2 Sink Interface

Every sink implements a common interface:

```ts
interface EventSink {
  readonly id: string;
  readonly enabled: boolean;
  deliver(event: EnrichedEvent): Promise<void>;
  flush?(): Promise<void>;
}
```

Sinks receive enriched events in dispatch order. If a sink throws or rejects, the
failure is captured as a diagnostic event but does not propagate to the bus or other
sinks.

### 4.3 Built-in Sink: Local Event Recording

The runtime always records enriched events into cast artifacts regardless of
configuration. This is the "local recording" sink — it cannot be disabled. Events
are written to an event artifacts directory under the cast run directory.

Existing `events.jsonl` behavior (used for operational events like `cast_start`,
`socket_start`, `cast_end`) is preserved and remains separate. Runtime events from
this system are recorded in a separate artifact path to avoid conflicts with the
existing event stream format.

### 4.4 Configurable Sink: Webhook Delivery

A generic webhook sink delivers events to an external HTTP endpoint. Configuration
is covered in §6.

## 5. Local Event Recording

### 5.1 Artifact Location

Enriched events are recorded under the cast artifact directory:

```
{runDir}/events/events.jsonl
```

Each line is a JSON object:

```jsonl
{"eventId":"evt_abc...","type":"result.pr_created","occurredAt":"2026-06-16T22:00:00Z","sequence":12,"castId":"2026-06-16T22-00-00-000Z","socketId":"Socket-7","materia":"Blackbelt-GH-PR","visit":1,"itemKey":"WI-3","itemLabel":"feat: implement retry logic","severity":"info","message":"PR #42 created for retry handling","payload":{"prUrl":"https://github.com/org/repo/pull/42","branchName":"agent/42-add-retry"}}
```

### 5.2 Dispatch Outcome Recording

A companion artifact records dispatch outcomes per event:

```
{runDir}/events/dispatch.jsonl
```

Each line records which sinks received the event and any failures:

```jsonl
{"eventId":"evt_abc...","deliveredTo":["local-recording","agent-controller-webhook"],"failures":[],"occurredAt":"2026-06-16T22:00:00.100Z"}
```

### 5.3 Separation from Existing events.jsonl

The existing `events.jsonl` at `{runDir}/events.jsonl` records operational lifecycle
transitions (`cast_start`, `socket_start`, `cast_end`, etc.) used by the WebUI and
catalog. This existing file is **not** changed by the runtime eventing system. Runtime
events go to `{runDir}/events/events.jsonl` — a separate path.

Lifecycle events emitted through the new event bus (§7) are recorded in the new
`events/events.jsonl` path. The existing `events.jsonl` retains its current format and
purpose.

## 6. Webhook Sink Configuration

### 6.1 General Design

The webhook sink is a generic, configuration-driven HTTP delivery mechanism. It is
not specific to any external system. The agent_router is one supported target
configured through a preset (§9).

### 6.2 Configuration Shape

```ts
interface EventingWebhookSinkConfig {
  id: string;                  // unique sink identifier
  enabled?: boolean;           // default true
  url: string;                 // POST endpoint URL
  method?: "POST" | "PUT";     // default "POST"
  headers?: Record<string, string>; // static headers
  bodyTemplate?: "passthrough" | "mapped" | "none"; // default "mapped"
  bodyMapping?: EventBodyFieldMapping; // used when bodyTemplate is "mapped"
  eventFilter?: EventFilter;   // which event types to deliver
  timeoutMs?: number;          // request timeout (default 10000)
  maxRetries?: number;         // retries on network/5xx (default 3)
  retryBackoffMs?: number;     // initial backoff (default 1000, exponential)
  maxBackoffMs?: number;       // max backoff cap (default 30000)
  discardingAfter?: number;    // drop after this many consecutive failures (default 10)
}
```

### 6.3 Body Mapping

When `bodyTemplate` is `"mapped"`, the webhook body is constructed from the enriched
event using a field mapping:

```ts
interface EventBodyFieldMapping {
  eventId: "eventId" | string;
  eventType: "type" | string;
  occurredAt: "occurredAt" | string;
  severity: "severity" | string;
  message: "message" | string;
  payload: "payload" | string;
  // additional static fields merged into the body
  static?: Record<string, unknown>;
}
```

The mapping specifies which enriched event field populates each body field. Values
like `"eventId"` mean "use the enriched event's `eventId` field verbatim." Static
fields are merged into every delivery body.

When `bodyTemplate` is `"passthrough"`, the complete enriched event object is sent
as the request body.

When `bodyTemplate` is `"none"`, the body is an empty object `{}` (for webhooks that
only need headers or the URL itself to convey intent).

### 6.4 Event Filtering

Each sink can filter which events it receives:

```ts
interface EventFilter {
  include?: string[];  // glob-like type patterns to include (e.g. ["result.*", "lifecycle.*"])
  exclude?: string[];  // glob-like patterns to exclude (takes priority over include)
}
```

If no filter is specified, all events are delivered. Filters use simple wildcard
matching where `*` matches any sequence of characters in a dot-separated segment.

### 6.5 Delivery Semantics

- **Non-blocking**: Webhook delivery is initiated after enrichment and does not block
  handoff processing. The cast continues regardless of delivery outcome.
- **Best-effort**: Retries cover transient network errors and 5xx responses. After
  `maxRetries` attempts or `discardingAfter` consecutive failures, the event is
  dropped for that sink.
- **Timeout**: Each delivery attempt has a configurable timeout. Timeouts count as
  retryable failures.
- **Ordering**: Events are delivered in dispatch order per sink. A slow delivery does
  not block subsequent event dispatches to the same or other sinks.
- **Response handling**: 2xx responses are treated as success. Non-2xx responses
  (except 5xx which may be retried) are recorded as failures.

### 6.6 Secret Redaction

Headers configured in `headers` may contain sensitive values (e.g. authentication
tokens). The runtime must:

- Never log header values at any log level.
- Never write header values to cast artifacts or dispatch logs.
- Only record header *names* in diagnostics (e.g. `"Authorization: [redacted]"`).
- Never include token values in error messages, logs, or API error responses.

This follows the same pattern documented in [Utility Materia — External integration utilities](utility-materia.md#authentication).

## 7. Runtime-Owned Lifecycle Events

pi-materia itself emits lifecycle events through the same event bus. These events
use a `lifecycle.` prefix to distinguish them from materia-emitted events.

### 7.1 Event Types

| Event Type | When Emitted | Severity |
|-----------|-------------|----------|
| `lifecycle.cast.started` | Cast begins execution | `info` |
| `lifecycle.cast.completed` | Cast finishes successfully | `info` |
| `lifecycle.cast.failed` | Cast fails | `error` |
| `lifecycle.cast.cancelled` | Cast is cancelled | `warning` |
| `lifecycle.socket.started` | Socket turn begins | `debug` |
| `lifecycle.socket.completed` | Socket turn completes | `debug` |
| `lifecycle.socket.failed` | Socket turn fails | `error` |
| `lifecycle.refinement.waiting` | Multi-turn socket waiting for user refinement | `info` |
| `lifecycle.heartbeat` | Periodic liveness signal (configurable) | `debug` |
| `lifecycle.status` | Arbitrary status update from the runtime | `info` |

### 7.2 Event Shape

```ts
interface LifecycleEventPayload {
  // For cast events
  loadoutId?: string;
  loadoutName?: string;
  request?: string;

  // For socket events
  socketId?: string;
  materia?: string;
  materiaLabel?: string;
  visit?: number;
  itemKey?: string;
  itemLabel?: string;

  // For failure events
  error?: string;
  errorKind?: string;

  // For heartbeat
  phase?: string;
  elapsedMs?: number;
}
```

### 7.3 Heartbeat

Heartbeat emission is configurable (see §8). While a cast is active (neither completed,
failed, nor cancelled), the runtime emits `lifecycle.heartbeat` events at the configured
interval. Heartbeats stop when the cast reaches a terminal state.

### 7.4 Terminal Event Guarantee

The runtime guarantees exactly one terminal event per cast:

- **Successful completion**: `lifecycle.cast.completed`
- **Failure**: `lifecycle.cast.failed`
- **Cancellation**: `lifecycle.cast.cancelled`

Terminal events include accumulated result context (see §10). The runtime attempts to
emit the terminal event even during process-shutdown-adjacent paths (e.g. SIGTERM with
a brief grace period).

## 8. Eventing Configuration Schema

### 8.1 Top-Level Config

Eventing configuration is a top-level `eventing` section in `PiMateriaConfig`:

```ts
interface EventingConfig {
  enabled?: boolean;          // master switch — default false
  sinks?: Record<string, EventSinkConfig>; // named sink configurations
  heartbeatIntervalMs?: number; // heartbeat emission interval (default 30000 = 30s)
  presets?: string[];         // named preset configurations to apply ("agent-controller", etc.)
}
```

### 8.2 Sink Config Union

```ts
type EventSinkConfig = EventingWebhookSinkConfig | EventingDisabledSinkConfig;

interface EventingDisabledSinkConfig {
  id: string;
  enabled: false;
}
```

### 8.3 Defaults

The default config sets `eventing.enabled` to `false`. No sinks are configured by
default. No heartbeats are emitted by default. This is a conservative, opt-in design:
users enable eventing explicitly when they need it.

### 8.4 Layered Config Behavior

Eventing configuration follows the same layered merge semantics as other top-level
config sections (budget, limits, compaction):

- Default layer provides the base (disabled, no sinks).
- User/project/explicit layers can enable eventing and add sinks.
- Sinks are merged by `id`. Setting a sink's `enabled` to `false` disables it.
- Setting a sink to `null` removes it from the effective config.
- Presets are additive — they enable pre-defined sink configurations that users can
  override or extend.

### 8.5 Unknown and Disabled Sinks

- Unknown sink types (not "webhook" or "disabled") are logged as warnings and treated
  as disabled. They do not cause config load failures.
- Disabled sinks (`enabled: false`) are retained in config but skipped during dispatch.
- Attempting to deliver to a disabled or unknown sink is a no-op.

## 9. Agent-Controller Integration (Preset)

The agent controller integration is **configuration**, not hard-coded logic. It is
provided as a named preset `"agent-controller"` that users can reference in their
eventing config.

### 9.1 Preset Activation

```json
{
  "eventing": {
    "enabled": true,
    "presets": ["agent-controller"]
  }
}
```

This preset configures a webhook sink targeting the agent controller's runtime event
endpoint with body mapping that translates generic pi-materia events to the controller's
`runtime.*` event contract.

#### 9.1.1 Auto-activation from a controller launch

When agent_router invokes pi-materia it sets the `CONTROLLER_*` environment
variables (`CONTROLLER_RUN_ID`, `CONTROLLER_EVENT_URL`, `CONTROLLER_CONTEXT_DIR`)
but does **not** set the documented `PI_MATERIA_EVENTING_*` overlay variables.
To make the preset activate without manual config, the eventing env overlay
(see §8.4) detects a controller launch from any non-empty `CONTROLLER_*` var
and, when one is present, auto-enables eventing and adds the `agent-controller`
preset — unless an explicit `PI_MATERIA_EVENTING_*` value already set that
field.

Composition rules (precedence: explicit overlay wins per field):

| Field | Explicit `PI_MATERIA_EVENTING_*` | Controller launch (no explicit) | Result |
|-------|----------------------------------|---------------------------------|--------|
| `enabled` | `ENABLED=true/false` | `enabled=true` | explicit value, else controller default |
| `presets` | `PRESETS=...` | `presets=["agent-controller"]` (additive) | explicit list, else controller default merged onto config |
| `heartbeatIntervalMs` | `HEARTBEAT_MS=N` | unchanged | explicit value, else config default |

Opt-out: a controller launch never overrides an explicit
`PI_MATERIA_EVENTING_ENABLED=false`, so a launcher can disable eventing even
when running under agent_router. The activation is in-memory only and is never
written back to config files (it is persisted for the cast lifetime via the
resolved config artifact). A diagnostic is surfaced in session logs when
controller activation engages.

### 9.2 Event Mapping

The preset maps pi-materia events to agent controller events:

| pi-materia Event | Controller Event | Notes |
|-----------------|-----------------|-------|
| `lifecycle.cast.started` | `runtime.accepted` | `castId` → `runtimeRunId` |
| `lifecycle.heartbeat` | `runtime.heartbeat` | `castId` → `runtimeRunId` |
| `lifecycle.status` or `status.*` | `runtime.status` | `message` mapped verbatim |
| `result.pr_created` | `runtime.pr_created` (optional) | PR fields from payload |
| `result.branch_pushed` | `runtime.branch_created` (optional) | Branch fields from payload |
| `result.needs_human` | `runtime.needs_human` | `message` → `message` |
| `lifecycle.cast.completed` | `runtime.completed` | Outcome from accumulated results (§10) |
| `lifecycle.cast.failed` | `runtime.failed` | Error from payload |
| `lifecycle.cast.cancelled` | `runtime.cancelled` | — |

The preset maps `lifecycle.cast.completed` to `runtime.completed` with a
`payload.outcome` derived from accumulated result events (§10).

### 9.3 Controller Run ID Resolution

The controller's `runId` is resolved from:

1. `CONTROLLER_RUN_ID` environment variable — set by the controller when
   invoking pi-materia (per agent_router docs §13b.5).
2. `CONTROLLER_CONTEXT_DIR` environment variable — if set, looks for
   `controller-run.json` directly inside that directory (no `.agent/`
   subdirectory; the agent_router writes context files flat into the
   context dir per docs §7.3 and §13b.5).
3. An explicit context directory passed programmatically — same lookup
   as step 2.

Resolution is tried in order; the first non-empty value is used. If no `runId` is
resolved, the controller webhook sink logs a warning and skips delivery (rather than
failing the cast).

pi-materia's `castId` is used as the `runtimeRunId` field in mapped controller events.

### 9.4 Preset Body Mapping

The preset uses body mapping to translate the enriched event into the controller's
expected envelope (§2 of the controller runtime event contract):

```json
{
  "eventId": "$.eventId",
  "eventType": "<mapped from pi-materia type>",
  "runtimeRunId": "$.castId",
  "occurredAt": "$.occurredAt",
  "severity": "$.severity",
  "message": "$.message",
  "payload": "$.payload",
  "sequence": "$.sequence"
}
```

### 9.5 Preset as Configuration Example

The `"agent-controller"` preset is an example of what the generic eventing system can
support. Users can define their own sinks with different URLs, mappings, filters, and
delivery parameters for any external system that accepts HTTP webhooks.

### 9.6 Webhook Activation Diagnostics

When agent-controller webhook delivery is **expected** (a controller launch is
detected, the `agent-controller` preset is referenced, or an `agent-controller-webhook`
sink is configured) the runtime evaluates whether delivery will actually be active
and surfaces clear diagnostics. This exists so agent_router integration gaps — the
most common cause of "we fired webhooks at the wrong location / never received state
updates" — are debuggable from session logs and cast artifacts.

Diagnostics are **non-fatal**: they never fail config load, the cast, or unrelated
local runs. When no delivery is expected (ordinary local run with no controller /
preset / sink), no diagnostics are produced.

Each diagnostic is written to the cast's operational event stream as an
`eventing_webhook_diagnostic` entry and echoed to `console.warn`:

```jsonl
{"ts": 1234567890, "type": "eventing_webhook_diagnostic", "data": {"severity": "warning", "reason": "run_id_unresolved", "message": "Controller launch detected but no runId could be resolved...", "active": false}}
```

Reported reason codes:

| Reason | When emitted |
|--------|--------------|
| `eventing_disabled` | Eventing master switch is off, so no events are dispatched. |
| `preset_missing` | Eventing is enabled but neither the `agent-controller` preset nor an `agent-controller-webhook` sink is present. |
| `controller_environment_missing` | The preset/sink is configured but no `CONTROLLER_*` environment was detected (running outside an agent_router launch). |
| `run_id_unresolved` | A controller launch was detected but no runId could be resolved (set `CONTROLLER_RUN_ID` or provide `controller-run.json`). The preset disables the sink in this case. |
| `target_url_missing` | The configured sink has no `url`. |
| `target_url_invalid` | The configured sink `url` is not an absolute http(s) URL. |
| `sink_disabled` | The sink is explicitly disabled (`enabled: false`) for a reason other than an unresolved runId. |
| `active` | Informational confirmation: delivery is active. Includes the redacted target URL (origin + pathname; query/fragment stripped per §6.6). |

When delivery is active, a single `info` diagnostic with reason `active` is emitted
instead of warnings, so a successful agent_router integration is positively
confirmable from the artifact stream. Diagnostics are emitted once per cast
initialization (at cast start and on recast/revive), reflecting the fully-resolved
sink after preset expansion.

## 10. Result Accumulation and Final Outcome

### 10.1 Accumulation

The runtime tracks all `result.*` events emitted during a cast. Result events
accumulate in a cast-scoped list:

```
cast.resultEvents = [
  { type: "result.branch_pushed", ... },
  { type: "result.pr_created", ... },
]
```

### 10.2 Final Outcome Derivation

When the cast reaches a terminal state, the runtime derives a final outcome from
accumulated result events using this precedence:

1. **`result.pr_created`** — PR was created. Outcome: `pull_request_opened`.
2. **`result.branch_pushed`** — Branch was pushed (but no PR). Outcome: `branch_pushed`.
3. **`result.no_changes_needed`** — No code changes required. Outcome: `no_changes_needed`.
4. **`result.needs_human`** — Human input needed. Outcome: `needs_human`.
5. **Default** — Work completed but no explicit success result. Outcome: `patch_created`.

The precedence ensures that `pull_request_opened` wins over `branch_pushed` when both
are emitted during the same cast, and so on.

### 10.3 Conflicting/Multiple Results

If the same result type is emitted multiple times (e.g. two `result.pr_created` events
for different PRs), the **last** event of that type wins for that type's signal. The
precedence ladder then resolves across types.

If both `result.needs_human` and `result.pr_created` are emitted, the precedence ladder
means `pr_created` wins. This is intentional: if the materia managed to create a PR
and then encountered a human-blocking issue, the PR exists and should be reported.

### 10.4 Final Outcome in Terminal Events

The derived final outcome is included in the `lifecycle.cast.completed` event payload
and, when the agent-controller preset is active, mapped to the `runtime.completed`
event's `payload.outcome` field.

## 11. Synthetic Context for Event Emission

### 11.1 Agent Prompt Instructions

JSON-output agent materia receive concise instructions in their synthetic context
explaining how to emit events. The instructions cover:

- The `event` field is an optional top-level array.
- Event type naming conventions (`result.*`, `status.*`, `error.*`).
- That `event` is not part of the handoff contract — it will not affect routing,
  assignment, or downstream state.
- That `event` is transmitted to configured external systems and recorded in cast
  artifacts for diagnostics.

### 11.2 Result Event Examples

| Scenario | Event |
|----------|-------|
| PR created | `{ "type": "result.pr_created", "message": "PR #42 created", "payload": { "prUrl": "...", "branchName": "...", "baseBranch": "main" } }` |
| Branch pushed (no PR) | `{ "type": "result.branch_pushed", "message": "Branch agent/42 pushed", "payload": { "branchName": "agent/42-add-retry", "remote": "origin" } }` |
| No changes needed | `{ "type": "result.no_changes_needed", "message": "No code changes required; acceptance criteria already satisfied." }` |
| Needs human input | `{ "type": "result.needs_human", "severity": "warning", "message": "Ambiguous acceptance criteria for retry behavior.", "payload": { "reason": "ambiguous_acceptance_criteria", "questions": ["Should 429 be retried?"] } }` |

### 11.3 Status/Progress Events

| Scenario | Event |
|----------|-------|
| Phase progress | `{ "type": "status.progress", "message": "Running unit tests", "payload": { "phase": "validation" } }` |
| Status update | `{ "type": "status.info", "message": "Identified 3 files needing changes", "payload": { "filesAffected": 3 } }` |

### 11.4 Utility Event Emission

Utility materia that produce JSON output may also emit `event` arrays. This is useful
for deterministic utilities that integrate with external services — for example,
`Blackbelt-GH-PR` can emit `result.pr_created` directly from its deterministic output:

```json
{
  "state": {
    "blackbeltGhPr": { "ok": true, "prUrl": "...", "prNumber": 42 }
  },
  "event": [
    {
      "type": "result.pr_created",
      "message": "PR #42 created",
      "payload": { "prUrl": "...", "prNumber": 42 }
    }
  ]
}
```

### 11.5 Instruction Wording

The synthetic context addition is kept minimal and separate from the main handoff
contract instructions:

```
## Event Emission (Optional)

If this materia produces JSON output, it may include an optional top-level `event`
array to report results and status to external systems. This is a side-channel —
it does not affect routing, assignment, or downstream state.

Event objects require `type` (e.g. "result.pr_created", "status.progress") and
optionally `severity`, `message`, and `payload`.

Examples:
- { "type": "result.pr_created", "message": "PR #42 created", "payload": { "prUrl": "..." } }
- { "type": "status.progress", "message": "Running validation tests" }
```

Text sockets are not told about `event` since they cannot produce JSON.

## 12. Integration with Existing Documentation

### 12.1 Handoff Contract

The [Handoff Contract](handoff-contract.md) defines the agent-authored JSON handoff
fields: `workItems`, `satisfied`, and `context`. The `event` field is explicitly **not**
part of the agent handoff contract. It is a runtime side-channel that is stripped
before handoff validation. See §3.5 of this document.

### 12.2 Utility Materia

[Utility Materia](utility-materia.md) documents utility JSON output, state patches, and
the separation from agent handoff JSON. Utility JSON output may now also include an
`event` field following the same rules as agent-emitted events. The `event` field is
stripped before utility state patch extraction and does not affect `state.*` merging.

## 13. Implementation Order

This design contract is the first work item. Subsequent work items implement the system
in the following order:

1. **Eventing configuration schema and persistence** — Config types, defaults, merge,
   save, serialization.
2. **Internal event model and validation** — Runtime event shape, validator.
3. **Runtime event enrichment and sequencing** — eventId, occurredAt, sequence, castId,
   socketId, materia, visit, item metadata.
4. **Event bus dispatch and local event recording** — Internal pipeline, sink interface,
   artifact recording.
5. **Configurable webhook sink delivery** — URL, headers, body templates, filters,
   timeout, retries, backoff, secret redaction.
6. **Process materia event side-channel** — Extract, validate, enrich, dispatch in
   JSON socket completion.
7. **Strip event before handoff semantics** — Remove `event` before validation,
   assignment, routing, state handoff, prompt context.
8. **Synthetic context for event emission** — Prompt instructions and examples.
9. **Accumulate result events for final outcome** — Track result events, derive
   precedence-based outcome.
10. **Emit lifecycle events through event bus** — cast start, socket start/complete,
    refinement, failure, cancel, completion.
11. **Heartbeat and terminal event handling** — Configurable heartbeat, terminal
    event guarantees.
12. **Agent-controller webhook preset** — Preset configuration, event mapping,
    runId resolution.
13. **Update PR utilities to emit result events** — Blackbelt-GH-PR and other
    utilities emit `result.*` events.

## 14. Design Decisions and Rationale

| Decision | Rationale |
|----------|-----------|
| `event` is always an array | Even single events are in an array to keep parsing uniform and support batches. Empty arrays are legal no-ops. |
| Events stripped before handoff | Prevents `event` from leaking into state, routing, or downstream prompts. Events are a side-channel, not a handoff element. |
| Best-effort webhook delivery | The cast must not fail because a webhook endpoint is unreachable. Sink failures are diagnostics, not cast failures. |
| Result accumulation with precedence | Different materia may emit different result types; the runtime resolves the strongest signal without requiring materia coordination. |
| Agent-controller as preset, not hard-coded | The eventing system is generic. Any external system that accepts HTTP webhooks can be integrated through configuration. |
| Separate artifact path from existing events.jsonl | Avoids breaking existing tooling (WebUI, catalog) that reads the current events.jsonl format. |
| Heartbeat is configurable and opt-in | Not all use cases need heartbeats. The default is off to avoid unnecessary noise. |
| Secret redaction in webhook delivery | Follows the same security pattern as external integration utilities. Credentials must never appear in logs or artifacts. |
