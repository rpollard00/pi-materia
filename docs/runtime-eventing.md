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

Each line records the per-sink outcome for one event. The authoritative detail
lives in the `sinks` array; `deliveredTo` and `failures` are backward-compatible
derived views:

```jsonl
{"eventId":"evt_abc...","occurredAt":"2026-06-16T22:00:00.100Z","sinks":[{"sinkId":"local-recording","status":"delivered"},{"sinkId":"agent-controller-webhook","status":"delivered","statusCode":200}],"deliveredTo":["local-recording","agent-controller-webhook"],"failures":[]}
```

Because webhook delivery is non-blocking (§6.5), the event bus records a
provisional `queued` status for a webhook sink at dispatch time and reconciles
the **real** outcome (drained from the sink) during the cast's terminal
`flush()`. The persisted artifact therefore reflects actual HTTP results rather
than a falsely-optimistic "delivered" recorded the moment the event was queued.
This is what makes agent_router integration gaps (wrong URL, 4xx/5xx, filtered
out, missing/invalid URL) debuggable from cast artifacts.

Per-sink `status` values:

| Status | Meaning |
|--------|---------|
| `delivered` | Synchronous sink delivered, or webhook returned 2xx. Includes `statusCode`. |
| `failed` | Delivery failed after retries, or hit a non-retryable error. Includes `statusCode` (when known), `reason`, and a redacted `error`. |
| `skipped` | The sink intentionally did not deliver — disabled or excluded by `eventFilter`. Includes `reason` (`disabled` or `filtered_out`). |
| `queued` | Handed to an async sink but the real outcome is not yet known (pre-flush). |
| `misconfigured` | The sink configuration is unusable (missing/invalid URL). Not retried. Includes `reason` (`target_url_missing` / `target_url_invalid`). |

`reason` codes align with the webhook activation diagnostics in §9.6
(`http_error`, `timeout`, `network_error`, `filtered_out`, `disabled`,
`target_url_missing`, `target_url_invalid`, etc.) so artifact consumers can
correlate dispatch failures with startup diagnostics. Error/detail strings are
redacted per §6.6 (no header values, tokens, or query strings).

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

#### 9.1.2 Launch Environment Contract

agent_router and pi-materia communicate the eventing integration entirely
through process environment variables at launch time. There are two distinct
variable families; confusing them is the single most common cause of "webhooks
fire at the wrong location / controller never sees state updates".

**Family A — `CONTROLLER_*` (set by agent_router, read by pi-materia).**
agent_router sets exactly these when it invokes pi (see agent_router docs
§13b.5 / `PiMateriaRuntime.cs`):

| Variable | Example value | Purpose |
|----------|---------------|---------|
| `CONTROLLER_RUN_ID` | `run_a1b2c3d4` | Controller run identifier; authoritative for event correlation. Primary runId resolution source (§9.3). |
| `CONTROLLER_EVENT_URL` | `http://localhost:5103/runs/run_a1b2c3d4/events` | The **full POST endpoint** the agent-controller webhook targets. Used verbatim when it contains a path; query/fragment are stripped only for redaction in diagnostics (§6.6). |
| `CONTROLLER_CONTEXT_DIR` | `/home/.../runs/run_a1b2c3d4/context` | Directory containing `controller-run.json` (written flat — no `.agent/` subdirectory). Fallback runId resolution source (§9.3). |

agent_router does **not** set any `PI_MATERIA_EVENTING_*` variable. The
controller launch is detected from the presence of any non-empty
`CONTROLLER_*` var (§9.1.1), which is what auto-activates the preset.

**Family B — `PI_MATERIA_EVENTING_*` (optional, launcher-set overlay).**
A documented overlay a launcher may set to control the top-level eventing
switches **without editing config files**. agent_router itself leaves these
unset (relying on auto-activation), but a wrapper, test harness, or operator
can set them — for example to force eventing on against a project config that
disables it, or to opt out under a controller launch:

| Variable | Format | Maps to | Parsing |
|----------|--------|---------|---------|
| `PI_MATERIA_EVENTING_ENABLED` | boolean | `eventing.enabled` | Case-insensitive `true`/`false`, `1`/`0`, `yes`/`no`, `on`/`off`. Any other value is ignored + warning. |
| `PI_MATERIA_EVENTING_PRESETS` | list | `eventing.presets` (additive) | Split on commas and/or whitespace; de-duplicated, first-occurrence order preserved. Empty/all-separators → treated as unset (no diagnostic). |
| `PI_MATERIA_EVENTING_HEARTBEAT_MS` | positive integer (ms) | `eventing.heartbeatIntervalMs` | Digits only (no `+`/`-`/decimals); must be `> 0`. Any other value is ignored + warning. |

Overlay semantics (implemented in `src/eventing/envOverlay.ts`, applied by
`src/config/config.ts#applyEventingEnvOverlay`):

- **Only the three documented variables above are parsed.** Any other
  `PI_MATERIA_EVENTING_*` variable (a typo or an invented name) is ignored
  entirely — pi-materia will not act on or warn about it. If an overlay is
  silently being ignored, confirm the variable name matches exactly.
- **Unset / empty / whitespace-only values are ignored**, not treated as
  "false" or "empty list". To disable eventing explicitly, set
  `PI_MATERIA_EVENTING_ENABLED=false`.
- **Invalid values are ignored and reported as a non-fatal warning** via
  `console.warn` (mirroring profile-config diagnostics). They never fail
  config load or the cast.
- **Applied after `mergeConfigLayers`** — i.e. on top of
  default/central/user/project/explicit config — so launch-time values win.
  This is what lets an operator turn eventing on at launch even when the
  project config left it disabled.
- **In-memory only.** The overlay is never written back to config files. The
  resolved config (overlay applied) is captured in the cast's
  `config.resolved.json` artifact for inspection.
- **Composed with controller auto-activation** per the precedence table in
  §9.1.1: an explicit overlay value always wins per field; controller
  activation only fills in fields the overlay left unset. So
  `PI_MATERIA_EVENTING_ENABLED=false` is a hard opt-out even under a
  controller launch, while `PI_MATERIA_EVENTING_PRESETS=agent-controller`
  produces the same preset without relying on controller detection.

The overlay deliberately does **not** expose webhook URL, headers, filters, or
any sink-level detail — those come from preset expansion (§9.3/§9.4) reading
the `CONTROLLER_*` family. Exposing only the top-level switches keeps the
launcher contract small and avoids leaking secrets through env vars.

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

### 9.7 Webhook Delivery Troubleshooting

The end-to-end delivery path has several stages; a failure at any stage has a
distinct, observable signature. Map an observed symptom to a root cause using
the table below. Primary evidence sources:

1. **Session log** (`console.warn`/`console.log` — `logs/pi.stderr.log` /
   `logs/pi.stdout.log` under agent_router) for startup activation
   diagnostics (§9.6).
2. **`{runDir}/events/dispatch.jsonl`** for per-event delivery outcomes (§5.2).
3. **`{runDir}/config.resolved.json`** to confirm the overlay resolved as
   expected (§9.1.2).

| Symptom | Evidence | Diagnostic / status reason | Likely cause | Fix |
|---------|----------|----------------------------|--------------|-----|
| Controller receives **no events at all** | session log | `eventing_disabled` | `eventing.enabled` is false in resolved config (project config disabled it and nothing re-enabled it). | Set `eventing.enabled=true`, or `PI_MATERIA_EVENTING_ENABLED=true` at launch. |
| No events; preset missing | session log | `preset_missing` | Eventing on but `agent-controller` not in resolved `presets` and no `agent-controller-webhook` sink. | Add `"agent-controller"` to `eventing.presets`, or rely on auto-activation (ensure a `CONTROLLER_*` var is set). |
| Manual/local run, no controller env | session log | `controller_environment_missing` | Preset referenced but launched outside agent_router with no `CONTROLLER_*` env. | Set `CONTROLLER_RUN_ID`/`CONTROLLER_EVENT_URL`/`CONTROLLER_CONTEXT_DIR`, or run under agent_router. |
| Controller env present, sink created **disabled** | session log | `run_id_unresolved` | `CONTROLLER_RUN_ID` empty/unset and no `controller-run.json` in `CONTROLLER_CONTEXT_DIR`. | Set `CONTROLLER_RUN_ID`, or put a `controller-run.json` with a `runId` field in `CONTROLLER_CONTEXT_DIR`. |
| Events POST to the **wrong location** (404 / not found) | `config.resolved.json` sink `url` | `target_url_missing`, or sink `url` contains literal `{runId}` | `CONTROLLER_EVENT_URL` is a bare origin (no path) **and** runId unresolved → URL becomes `…/runs/{runId}/events` with a placeholder; or `CONTROLLER_EVENT_URL` unset and runId unresolved. | Set `CONTROLLER_EVENT_URL` to the **full** endpoint, and resolve runId (row above). |
| Sink URL rejected at startup | session log | `target_url_invalid` | `CONTROLLER_EVENT_URL` is relative, non-http(s), or malformed. | Provide an absolute `http://`/`https://` URL. |
| Sink explicitly off | session log | `sink_disabled` | An explicit `agent-controller-webhook` sink has `enabled: false` (not due to runId). | Remove the override or set `enabled: true`. |
| `dispatch.jsonl` stuck on `queued` | `dispatch.jsonl` status `queued` | — | The cast never reached a terminal flush path (crash/cancel before `bus.flush()`), so async results weren't reconciled. | Confirm the cast reached `lifecycle.cast.completed`/`failed`/`cancelled`; on crash the `queued` row is the best available evidence. |
| `dispatch.jsonl` shows `failed` | `statusCode` (4xx) | `http_error` (4xx, not retried) | Controller rejected the body — most often a non-`runtime.*` `eventType` (422) or wrong route (404). | Verify event types map to `runtime.*` (§9.2); verify `CONTROLLER_EVENT_URL` route. |
| `dispatch.jsonl` shows `failed` | `statusCode` (5xx) / `reason` | `http_error` (5xx, retried then failed) / `timeout` / `network_error` | Controller down, restarting, or unreachable; or request exceeded `timeoutMs`. | Check controller health; raise `timeoutMs`/`maxRetries` if transient. |
| `dispatch.jsonl` shows `skipped` | `reason` | `filtered_out` / `disabled` | Event type isn't in the preset's `eventFilter.include` (e.g. an unmapped `result.*`), or sink was disabled mid-cast. | Expected for unmapped types (they aggregate into `runtime.completed`); add a sink `include` filter only if you want them delivered. |
| `dispatch.jsonl` shows `misconfigured` | `reason` | `target_url_missing` / `target_url_invalid` | Sink URL unusable at dispatch (e.g. still the `{runId}` placeholder). Not retried. | Same fix as the `target_url_*` rows above; misconfigured dispatches are not retried. |

The positive path: when everything is wired, the session log contains exactly
one `info` diagnostic with reason `active` (and the redacted target URL), and
`dispatch.jsonl` shows `delivered` with a 2xx `statusCode` for the
`agent-controller-webhook` sink on every lifecycle and result event.

### 9.8 End-to-End Example

A representative agent_router launch sets only `CONTROLLER_*`:

```bash
# agent_router → pi-materia (set by PiMateriaRuntime.cs)
CONTROLLER_RUN_ID=run_a1b2c3d4
CONTROLLER_EVENT_URL=http://localhost:5103/runs/run_a1b2c3d4/events
CONTROLLER_CONTEXT_DIR=/home/user/.agent-work-controller/runs/run_a1b2c3d4/context
# controller-run.json exists in CONTROLLER_CONTEXT_DIR with { "runId": "run_a1b2c3d4", ... }
```

With no `PI_MATERIA_EVENTING_*` set and a project config that leaves eventing
disabled, `loadConfig` resolves as follows:

1. `mergeConfigLayers` produces `eventing.enabled=false` (project default).
2. Controller launch is detected (`CONTROLLER_RUN_ID` present) →
   `applyEventingEnvOverlay` auto-enables eventing and adds
   `presets=["agent-controller"]` (in-memory; no config file written).
3. At cast init, `initializeCastEventBus` expands the preset into an
   `agent-controller-webhook` sink with:
   - `url` = `CONTROLLER_EVENT_URL` (used verbatim — it already has a path),
   - `X-Controller-Run-Id: run_a1b2c3d4` header,
   - body mapping `type` → `runtime.*`, `castId` → `runtimeRunId`,
     `debug` severity → `info`.
4. Diagnostics emit one `info`/`active` entry; `config.resolved.json` shows
   `eventing.enabled=true` and the resolved sink URL.

During the cast, **both event sources flow through the same bus and the same
sink** (confirming the §9.1.2 guarantee that the overlay affects materia and
runtime events consistently):

- Runtime emits `lifecycle.cast.started` → POSTed as `runtime.accepted`.
- Materia emits `result.pr_created` (via the `event` side-channel, §2) →
  POSTed as `runtime.pr_created`.
- On completion, accumulated results derive `payload.outcome` (§10) and the
  terminal `lifecycle.cast.completed` → POSTed as `runtime.completed` with
  the derived outcome.

Each POST appears in `{runDir}/events/dispatch.jsonl`:

```jsonl
{"eventId":"evt_...","occurredAt":"2026-06-26T21:30:00.000Z","sinks":[{"sinkId":"local-recording","status":"delivered"},{"sinkId":"agent-controller-webhook","status":"delivered","statusCode":200}],"deliveredTo":["local-recording","agent-controller-webhook"],"failures":[]}
```

If `CONTROLLER_RUN_ID` had been unset and no `controller-run.json` existed,
the same launch would instead emit a `run_id_unresolved` warning, the sink
would be created `enabled:false`, and `dispatch.jsonl` would show **no**
`agent-controller-webhook` sink — which is exactly the "we never fired
webhooks" gap this contract exists to make debuggable.

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
