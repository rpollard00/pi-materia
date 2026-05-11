# Materia handoff JSON contract audit

Date: 2026-05-07

This historical audit covered materia-to-materia JSON handoff behavior before the canonical contract work. It is investigative only; the current canonical documentation is `docs/handoff-contract.md`.

## Current canonical contract

- JSON-parsed sockets must emit a top-level object when routing or advancement depends on handoff fields.
- Reserved routing/evaluation fields are `satisfied`, `feedback`, and `missing`.
- Generated units of work are `workItems`.
- Graph edge conditions are `always`, `satisfied`, and `not_satisfied`.
- Runtime, artifacts, usage, monitor, and persisted state use socket terminology for socket identity and state.

## Historical findings now superseded

The original audit found drift between prompt examples, runtime routing, and validation around older handoff aliases and graph terminology. The follow-up work centralized handoff guidance, validates reserved fields for routed JSON sockets, and updated default prompts to use the generic handoff envelope.

Archived examples in older planning material should not be treated as active contract documentation. When in doubt, use `docs/handoff-contract.md`, the default config prompts, and the schema/runtime tests as the source of truth.

## Ongoing guardrails

- Do not add alternate boolean routing fields.
- Do not route generated work through any field other than `workItems`.
- Keep prompt text, runtime validation, graph validation, tests, and WebUI copy aligned.
- Preserve handoff reserved fields: `workItems`, `satisfied`, `feedback`, and `missing`.
