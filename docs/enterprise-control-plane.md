# Enterprise control-plane architecture

**Status**: Prescriptive blueprint (implementation staged across follow-on work items).

This document is the authoritative design contract for expanding pi-materia from a
purely local tool into an enterprise-grade system, while keeping the local UI and the
purely local workflow first-class. Subsequent enterprise work items must start by
reading this document and conforming to the boundaries defined here.

It is written as a shared contract before broad implementation begins. It defines
modes, component responsibilities, config precedence, source-of-truth and local-override
rules, provenance and drift, the agent_router integration boundary, and the relationship
to the local quest board.

## 1. Goals and non-goals

### Goals

- Support a **centralized** catalog of loadouts and materia, centralized model-policy,
  centralized monitoring/telemetry, an admin UI, and enterprise authentication/RBAC —
  without forcing local users onto it.
- Keep **local-only** pi-materia fully functional: a user who never connects to a central
  control plane must lose no capability they have today.
- Introduce a **central-connected local runtime** mode where a local pi-materia runtime
  reads central catalog/model-policy and emits telemetry, while still executing casts
  locally and still owning its local session/UI.
- Introduce a **central/admin UI** mode for operators who manage catalog, policy,
  telemetry, and admin metadata without an attached local repository session.
- Make central definitions a **source of truth** that never silently overwrites local
  files. Moving central content into a local scope is always an explicit copy/update/
  replace action chosen by a user or API caller.

### Non-goals

- The **quest board is not** the enterprise backlog or claim model. It remains a
  project-local outer-loop queue (see [§9](#9-quest-board-relationship) and
  [Quest board](quest-board.md)). The enterprise control plane does not introduce a
  "central quest board."
- pi-materia is **not** the cast lifecycle, claim, or state-machine owner. That role
  belongs to `agent_router` (see [§3.1](#31-agent_router-lifecycle-claim-and-state-machine-owner)).
- The central control plane is **not** a replacement for local session monitoring. It
  aggregates telemetry from many runtimes; it does not take over live local artifact
  monitoring (see [WebUI architecture](webui-architecture.md)).

## 2. Supported operating modes

Every pi-materia process resolves to exactly one operating mode. Mode is reported
through control-plane capability metadata so UIs and clients can render the correct
surfaces.

| Mode | Local session | Central control plane | Typical user |
|------|---------------|----------------------|--------------|
| **`local-only`** | present | not configured | Individual developer; default. All current behavior unchanged. |
| **`central-connected`** | present | reachable/configured | Developer runtime that reads central catalog/model-policy and emits telemetry while still running casts locally. |
| **`central-admin`** | none (no local repo session) | reachable/configured | Operator using the central/admin UI to manage catalog, policy, telemetry, and admin metadata. |

Invariants:

- **Local UI and purely local workflow remain first-class.** `local-only` is the default
  and is fully featured. No central dependency may be introduced into the default
  `loadConfig` path, default WebUI startup, default model selection, or default cast
  lifecycle.
- **`central-connected` augments, never replaces, the local runtime.** A central outage
  must degrade gracefully: catalog/model-policy reads become stale or unavailable,
  telemetry delivery is best-effort (already non-blocking per
  [Runtime eventing §6.5](runtime-eventing.md#65-delivery-semantics)), and local casts
  continue.
- **`central-admin` has no local session.** It must not start a local repository session,
  must not touch `.pi/pi-materia/quest-board.json`, and must not expose local-session
  routes (active loadout, live artifact monitor, quest board) as if a session existed.

Mode capability metadata is exposed by the control-plane port abstraction so that
clients can distinguish `local-only`, `central-connected`, and `central-admin`
capabilities (see [§7](#7-control-plane-ports-and-dtos)). Quest APIs are intentionally
**not** part of this abstraction (see [§9](#9-quest-board-relationship)).

## 3. Component responsibilities

```
                       ┌─────────────────────────────────────────────┐
                       │            Central control plane             │
                       │  catalog · model-policy · telemetry · admin  │
                       │            auth (RBAC / OAuth)               │
                       └───────────────▲───────────────┬─────────────┘
   catalog/model-policy read          │               │  telemetry ingest (webhook sink)
   (best-effort, explicit local write)│               │
                                       │               │
   ┌───────────────────────────────────┴───────────────┴──────────────┐
   │                     pi-materia runtime                            │
   │  execution runtime · local UI · catalog/model-policy client ·     │
   │                     telemetry producer                            │
   └───────────────▲───────────────────────────────────▲──────────────┘
                   │ cast lifecycle, claim, state machine (runtime events)
                   │
        ┌──────────┴──────────┐
        │     agent_router     │
        │  (controller; one    │
        │   integration target)│
        └──────────────────────┘
```

### 3.1 `agent_router` — lifecycle, claim, and state-machine owner

`agent_router` is the external agent controller. It owns cast lifecycle orchestration,
work-item **claiming**, and the **state machine** for queued/claimed/running/settled
work. pi-materia never claims work on its own behalf in the enterprise model; it executes
casts that `agent_router` has claimed and dispatched, and it reports outcomes through the
existing runtime-event channel.

The agent-controller relationship is **configuration, not hard-coded logic**. It is
reached through the existing `"agent-controller"` eventing preset
([Runtime eventing §9](runtime-eventing.md#9-agent-controller-integration-preset)),
which maps pi-materia lifecycle/result events onto the controller's `runtime.*` event
contract. The enterprise control plane must not duplicate this mapping or invent a second
control channel into `agent_router`. See [§6](#6-agent_router-integration-boundary) for
the full boundary.

### 3.2 pi-materia — execution runtime, local UI, client, and producer

In the enterprise model pi-materia gains four secondary roles layered on top of its
existing execution role:

1. **Execution runtime** (unchanged): runs casts, manages sockets/handoff, writes local
   artifacts. See [Core plugin layering](core-layering.md).
2. **Local UI** (unchanged surface, mode-aware behavior): the WebUI continues to render
   local session state. In `central-connected`/`central-admin` it additionally renders
   central catalog/model-policy/admin state as separate surfaces, and guards
   local-session-only controls when no local session exists. See
   [WebUI architecture](webui-architecture.md) and [§8](#8-webui-integration).
3. **Central catalog/model-policy client**: reads central catalog and policy through
   control-plane ports. Reads never mutate local files (see
   [§10](#10-central-source-of-truth-with-local-override)).
4. **Telemetry producer**: emits enriched runtime events to the central control plane via
   the existing event bus + webhook sink contract ([Runtime eventing](runtime-eventing.md)).
   Telemetry delivery is best-effort and non-blocking.

### 3.3 Central control plane — catalog, model-policy, telemetry, admin, auth

The central control plane is a separate server and surface from the local session WebUI
server. It owns:

- **Catalog**: versioned loadout and materia definitions with stable ids, versions,
  provenance, and content hashes. Catalog data is **not** writable through normal
  local/project editing paths; only admin APIs may write it.
- **Model policy**: allow/deny/prefer and thinking-level constraints served as policy
  documents, independent of local Pi model availability. See [§11](#11-model-policy).
- **Telemetry ingestion**: receives enriched runtime events from many pi-materia
  runtimes and exposes monitoring read APIs.
- **Admin**: metadata and RBAC administration for the above.
- **Auth**: principal/role/permission resolution. Initial implementation is a
  development-token adapter; OAuth/OIDC is a documented **future** adapter boundary, not
  an implementation in the first uplift (see [§13](#13-authentication-and-rbac)).

## 4. Architectural layering

Enterprise additions follow the existing layering rules in
[Core plugin layering](core-layering.md). Dependency direction remains:

```
plugin composition -> native runtime/infrastructure adapters ->
  application ports/use cases -> domain
```

| Concern | Target layer | Notes |
|---------|--------------|-------|
| tenant, workspace, repository, project-local scope, principal, role, permission, auth context, audit metadata | `src/domain` | Pure contracts. No HTTP, OAuth, persistence, or UI deps. OAuth modeled as a future adapter boundary, not an implementation. |
| control-plane DTOs and ports (catalog, model-policy, telemetry/status, admin, mode metadata) | `src/application` | Ports only; no concrete HTTP/persistence adapters. |
| local control-plane adapter (wraps existing local config/model/monitoring) | `src/infrastructure` | Reuses existing local config/model/monitoring behavior; reports local mode capabilities. |
| central HTTP client adapter, central server, in-memory catalog repository, dev-token auth, RBAC middleware | new central package/module | Separate from local session WebUI server; in-memory adapters only at first. |

The local control-plane adapter must **not** change quest-board routes or semantics, and
must **not** couple central server startup to a local repository session.

## 5. Configuration precedence

Enterprise config extends the existing layered config model
([Core plugin layering](core-layering.md); implemented in `src/config/config.ts`). The
existing scopes are `default | user | project | explicit` (`MateriaConfigLayerScope`).

The enterprise uplift inserts the **central catalog** as a new source between bundled
defaults and the user layer. Effective precedence, lowest to highest:

```
bundled defaults  <  central catalog  <  user  <  project  <  explicit
```

- **Central catalog** contributes catalog-sourced loadout/materia definitions with
  `source: "central"` provenance. It is consulted only when a central control plane is
  configured/reachable and only for definitions that originated from or are tracked
  against a central catalog item.
- Because central sits *below* `user`/`project`/`explicit`, **local definitions always
  win** over central for the same id/name. Central never overrides a locally-authored
  override. This is the config-layering expression of the local-override rule
  ([§10](#10-central-source-of-truth-with-local-override)).
- In `local-only` mode the central layer is absent and precedence is unchanged from
  today: `default < user < project < explicit`.
- Surfacing central definitions must not break existing `loadoutSources`/`materiaSources`
  handling, shipped-default immutability, or loadout ownership/locking
  ([Loadout ownership and locking](loadout-ownership-locking.md)).

`"central"` is a **provenance/source value**, distinct from the writable local scopes.
Central definitions are surfaced read-only in the merged config; persisting central
content into a local scope requires an explicit action ([§12](#12-explicit-central-to-local-catalog-actions)).

### 5.1 Connection and server settings

A connected runtime is enabled only by an absolute HTTP(S) API URL. Resolution order is
`MATERIA_CENTRAL_API_URL`, profile `central.apiUrl`, then the compatible legacy profile
field `webui.centralApiBaseUrl`. `central.requestTimeoutMs` configures the client timeout
(default 5000 ms); `MATERIA_CENTRAL_REQUEST_TIMEOUT_MS` overrides it. If no API URL is
resolved, the runtime remains `local-only` and does not read secret files or perform
central network I/O.

The standalone server reads the following deployment settings:

| Variable | Meaning | Default |
|----------|---------|---------|
| `MATERIA_CENTRAL_HOST` / `MATERIA_CENTRAL_PORT` | HTTP bind host and port | `127.0.0.1` / `0` |
| `MATERIA_CENTRAL_DATABASE_PATH` | SQLite database path (relative to startup cwd when not absolute) | `data/pi-materia-central.sqlite` |
| `MATERIA_CENTRAL_RETENTION_DAYS` | Telemetry retention in days | `30` |
| `MATERIA_CENTRAL_CORS_ORIGIN` | CORS allow-origin response value | `*` (development compatibility) |
| `MATERIA_CENTRAL_LABEL` | Optional non-secret server label | unset |

Read, admin, and telemetry credentials are separate values:
`MATERIA_CENTRAL_READ_TOKEN`, `MATERIA_CENTRAL_ADMIN_TOKEN`, and
`MATERIA_CENTRAL_TELEMETRY_TOKEN`. Each supports a mutually exclusive `_FILE` companion
(for example `MATERIA_CENTRAL_ADMIN_TOKEN_FILE`) for Docker/Kubernetes secrets. Secret
contents are trimmed, never included in diagnostics, and never persisted in the profile.
Production credential requirements and development-token gating are applied by the auth
composition stage; these configuration contracts do not weaken route RBAC.

## 6. agent_router integration boundary

The enterprise control plane does **not** become a peer of `agent_router`, and
pi-materia does not become a second lifecycle/claim owner. The boundary is:

- **Lifecycle, claim, and state-machine ownership stays with `agent_router`.** pi-materia
  remains the execution runtime that runs a cast for work `agent_router` has dispatched.
- **There is one runtime event channel into `agent_router`**: the existing event bus →
  webhook sink → `"agent-controller"` preset
  ([Runtime eventing §9](runtime-eventing.md#9-agent-controller-integration-preset)).
  The control plane must not create a parallel control channel, a second claim protocol,
  or a duplicate state machine.
- **Telemetry is fan-out, not control.** The same enriched runtime events pi-materia emits
  to `agent_router` may also be ingested by the central control plane for monitoring. The
  central ingestion endpoint is a **sink**, not a controller: it records and serves events
  but does not issue lifecycle/claim/state commands back into pi-materia.
- **`runId` resolution is unchanged.** Controller run id continues to resolve from
  `CONTROLLER_RUN_ID` / `CONTROLLER_CONTEXT_DIR` / programmatic context
  ([Runtime eventing §9.3](runtime-eventing.md#93-controller-run-id-resolution)). The
  control plane does not override it.

## 7. Control-plane ports and DTOs

Application-level ports decouple pi-materia from any concrete central transport. Ports
are defined for: catalog access, model policy, telemetry/status, and admin metadata. Each
port exposes **mode metadata** so callers can distinguish `local-only`,
`central-connected`, and `central-admin` capabilities.

Rules:

- **No quest-board port.** Quest APIs are local-session functionality and are excluded
  from the control-plane abstraction (see [§9](#9-quest-board-relationship)).
- Ports return DTOs, never concrete adapter or transport types.
- The local control-plane adapter implements these ports for `local-only`/`central-connected`
  by wrapping existing local config, model, and monitoring behavior and reporting local
  capabilities — without altering quest-board routes/semantics.
- The central client/server implements these ports against the central control plane for
  `central-connected`/`central-admin`.

## 8. WebUI integration

The WebUI gains **backend mode discovery** and **local-only control guarding**, both
aligned to [WebUI architecture](webui-architecture.md).

- **Backend mode discovery**: a backend API and frontend client capability that reports
  whether the UI is connected to same-origin local session APIs, a configured central API
  base URL, or both. Capability metadata lets the frontend render central
  catalog/model-policy/admin state separately from local runtime/session state.
- **Guard local-only controls in central mode**: when connected only to the central
  control plane (`central-admin`), the UI hides/disables quest controls and other
  local-session-only actions (active runtime loadout controls, live local artifact
  monitoring). This changes **presentation/guarding only** — the quest board
  implementation itself is not modified (see [§9](#9-quest-board-relationship)).
- Route structure for the local session server is a stability surface
  ([WebUI architecture — Backend boundaries](webui-architecture.md#backend-boundaries));
  central routes live on the separate central server and must not be mixed into the local
  session dispatcher.

## 9. Quest board relationship

The [Quest board](quest-board.md) is pi-materia's **project-local** outer-loop queue,
stored at `.pi/pi-materia/quest-board.json`, with a single-writer convention and an
event-driven, project-local runner.

Enterprise invariants:

- **The quest board remains local-only.** It is not the enterprise backlog, the enterprise
  claim model, or a central queue. The enterprise control plane exposes no quest-board port
  ([§7](#7-control-plane-ports-and-dtos)) and does not synchronize boards across machines.
- **Backlog/claim is `agent_router`'s concern**, reached through runtime events
  ([§6](#6-agent_router-integration-boundary)), not through the local quest board.
- **No local session, no quest board.** In `central-admin` mode, with no local repository
  session, quest UI controls are guarded off ([§8](#8-webui-integration)).
- **The quest board implementation is not changed** by the enterprise uplift; only its
  UI visibility is guarded in central mode.

## 10. Central source-of-truth with local override

Central catalog definitions are the source of truth for what a loadout/materia *should*
be, but **local files are the source of truth for what is actually executed**, and central
never silently overwrites them.

- Central definitions enter the merged config at a lower precedence than local scopes
  ([§5](#5-configuration-precedence)), so a local override always wins.
- Moving central content into a local scope is always an **explicit** copy, update, or
  replace action chosen by a user or API caller ([§12](#12-explicit-central-to-local-catalog-actions)).
- Explicit actions must preserve shipped-default immutability and existing loadout
  ownership/locking ([Loadout ownership and locking](loadout-ownership-locking.md)). A
  central-sourced definition written to a local scope takes a normal local source
  (`user`/`project`/`explicit`), not a writable `central` scope.
- Overwrite behavior must be explicit in the API/UI: a replace that would overwrite an
  existing local definition requires confirmation and records provenance.

## 11. Model policy

Model policy constrains local model selection. The local Pi model registry remains the
**available-runtime** source of truth for which models can actually run
([`src/modelCatalog.ts`](../src/modelCatalog.ts); applied via
`applyMateriaModelSettings` in `src/config/modelSettings.ts`).

Policy contract (advisory vs. enforceable):

| Constraint | Behavior |
|-----------|----------|
| **deny** | Hard. Denied models must not be selected. |
| **allow** | Constrains the selectable set to listed models. |
| **prefer** | Advisory. Preferred models are suggested; the runtime warns or falls back when a preferred central model is unavailable locally. |
| **thinking-level** | Constrains thinking-level selection where required. |

Invariants:

- When **no central policy is configured** (`local-only`, or no policy served), existing
  local model selection behavior is preserved exactly.
- A preferred central model that is unavailable locally is a warning/fallback, never a
  hard failure that blocks casts.
- Model policy is exposed through central catalog/policy APIs and read independently from
  local Pi model availability; the WebUI can show policy state separately from the local
  model list.

## 12. Explicit central-to-local catalog actions

Because central never silently mutates local files, promoting central content is an
explicit, user/API-initiated flow:

| Action | Semantics |
|--------|-----------|
| **copy** | Write a central catalog definition to a local target (`user`, `project`, or `explicit`) as a new local definition with local provenance recorded (origin catalog item). |
| **update** | Refresh an existing local definition that originated from a central item to the latest central version. Explicit overwrite; requires confirmation if it would change local content. |
| **replace** | Overwrite an existing local definition with the central definition verbatim. Explicit overwrite; requires confirmation. |

All three:

- Preserve shipped-default immutability (a `default`-scoped loadout is never an in-place
  write target; duplicate first per [Loadout ownership and locking](loadout-ownership-locking.md)).
- Preserve loadout ownership/locking and the duplicate-name/ownership guardrails.
- Record origin/provenance so future drift can be detected
  ([§14](#14-provenance-and-drift)).
- Make overwrite behavior explicit and never apply central updates silently.

## 13. Authentication and RBAC

- **First implementation**: a development-token principal resolver for the central server,
  plus permission checks (RBAC) around central catalog, model-policy, admin, and telemetry
  routes, using the domain principal/role/permission contracts
  ([§4](#4-architectural-layering)).
- **Future boundary**: OAuth/OIDC is modeled as a future **auth adapter boundary**, not an
  implementation in this uplift. Domain contracts must not take a hard dependency on any
  OAuth/OIDC library; OAuth is an adapter that produces the same `AuthContext`/
  `Principal`/`Permission` contracts the dev-token adapter produces.
- Permission checks guard central routes only. Local session routes, local config editing,
  and local model selection are **not** gated by central RBAC; local-only behavior is
  unchanged.

## 14. Provenance and drift

Provenance tracks where a definition came from; drift tracks whether a local definition
that originated from a central catalog item is still in sync with central.

### 14.1 Provenance fields

A local loadout/materia definition that originated from a central catalog item records:

| Field | Meaning |
|-------|---------|
| `catalogItemId` | Stable central id of the origin catalog item. |
| `catalogVersion` | Central version at copy/update/replace time. |
| `catalogContentHash` | Content hash of the central definition at copy/update/replace time. |
| `source` | The local scope the definition now lives in (`user`/`project`/`explicit`). Never `central` for a writable local file. |

Central catalog items themselves carry their own `version`, `updatedAt`, `contentHash`,
and `provenance`.

### 14.2 Drift fields (resolved at load time)

When a central control plane is reachable, drift is computed by comparing a local
definition's recorded origin against the current central item:

| Field | Meaning |
|-------|---------|
| `centralVersion` | Current central version (resolved at load). |
| `centralContentHash` | Current central content hash (resolved at load). |
| `drift` | Drift status enum: `current`, `behind`, `diverged`, or `orphaned` (see below). |

Drift status semantics:

| Status | Condition |
|--------|-----------|
| `current` | Local origin matches central version/hash. |
| `behind` | Central has a newer version/hash; local content still equals the recorded origin hash (not locally edited since). |
| `diverged` | Local content no longer equals the recorded origin hash (locally edited) **and** central has changed. |
| `orphaned` | Origin `catalogItemId` no longer exists in central (deleted or renamed). |

The **content hash is the authoritative drift signal**: `behind`/`diverged` are
resolved from content-hash comparison, so a central metadata-only republish that
bumps `version` without changing definition content is treated as `current`.
`centralVersion` is still reported for UIs. Local and central content hashes
use the same deterministic key-stable digest, so an unedited local copy compares
equal to its recorded origin hash.

### 14.3 User-visible drift behavior

- Drift is **informational only**. It is surfaced in loaded config and in WebUI API
  responses so users/UIs can see and act on it.
- Drift detection **must not mutate local files automatically**. Resolving drift requires
  an explicit copy/update/replace action ([§12](#12-explicit-central-to-local-catalog-actions)).
- When the central control plane is unreachable, drift is left unset/stale rather than
  fabricated; local definitions continue to load and execute normally.

## 15. Telemetry and monitoring

- Central telemetry **ingestion** receives enriched runtime events emitted by local
  pi-materia runtimes, stored normalized in memory initially. It builds on the existing
  event bus and webhook **sink** contracts ([Runtime eventing](runtime-eventing.md)),
  not a new local-state synchronization channel.
- Central monitoring **read APIs** expose in-memory telemetry/status snapshots for future
  central monitoring views.
- Local artifact monitoring is **unchanged**. Central monitoring aggregates across runtimes
  and is not a replacement for local session monitoring
  ([WebUI architecture](webui-architecture.md)).

## 16. Implementation staging

This document is the first enterprise work item. Follow-on work items implement the
uplift in dependency order, each conforming to the boundaries above:

1. Enterprise scope and principal domain contracts ([§4](#4-architectural-layering)).
2. Control-plane DTO and port contracts ([§7](#7-control-plane-ports-and-dtos)).
3. Local control-plane adapter (local-only/`central-connected` capabilities; no quest
   changes) ([§7](#7-control-plane-ports-and-dtos), [§9](#9-quest-board-relationship)).
4. Central server skeleton, separate from the local session WebUI server ([§3.3](#33-central-control-plane-catalog-model-policy-telemetry-admin-auth)).
5. Dev-token auth and RBAC middleware ([§13](#13-authentication-and-rbac)).
6. Central catalog in-memory repository ([§3.3](#33-central-control-plane-catalog-model-policy-telemetry-admin-auth)).
7. Central catalog source in config layering ([§5](#5-configuration-precedence)).
8. Catalog provenance and drift detection ([§14](#14-provenance-and-drift)).
9. Explicit central-to-local catalog actions ([§12](#12-explicit-central-to-local-catalog-actions)).
10. WebUI backend mode discovery ([§8](#8-webui-integration)).
11. Guard WebUI local-only controls in central mode ([§8](#8-webui-integration), [§9](#9-quest-board-relationship)).
12. Model policy contracts ([§11](#11-model-policy)).
13. Central model catalog and policy APIs ([§11](#11-model-policy)).
14. Enforce model policy during local model selection ([§11](#11-model-policy)).
15. Central telemetry ingestion ([§15](#15-telemetry-and-monitoring)).
16. Central monitoring read APIs ([§15](#15-telemetry-and-monitoring)).

## 17. Related documents

- [Core plugin layering](core-layering.md) — layer rules, dependency direction, `default | user | project | explicit` scopes.
- [WebUI architecture](webui-architecture.md) — frontend/backend boundaries; route stability surface.
- [Runtime eventing](runtime-eventing.md) — event bus, sinks, webhook delivery, `agent-controller` preset, lifecycle/result events.
- [Loadout ownership and locking](loadout-ownership-locking.md) — shipped-default immutability, ownership, locking, duplicate guardrails.
- [Quest board](quest-board.md) — project-local outer-loop queue; local-only by design.
