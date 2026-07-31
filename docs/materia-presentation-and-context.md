# Materia presentation and context contract

This document defines the boundary between Materia cards that are visible in
Pi's transcript and content that is sent to the model.

## The short version

- Pi intercepts registered slash commands before ordinary user-input handling.
  Typing `/materia budget` therefore does not, by itself, create a user
  message or start a model turn.
- Use `appendMateriaPresentation` for command results and runtime cards that
  should be visible in the session view but must not be model context.
- The presentation helper uses `pi.appendEntry()` with the
  `pi-materia-presentation` custom-entry type. The renderer is registered once
  by `registerMateriaRenderer()` so those entries render as Materia cards.
- `pi.sendMessage()` creates a custom message. Its content participates in
  model context and Pi compaction even when `display: false` is set. Do not use
  it for display-only cards.
- `pi-materia-prompt` is reserved for the one intentional context-bearing
  message: dispatching an inference turn for a Materia cast.

A presentation entry is still durable session data, so it can appear in the
transcript after reload. It is not a `custom_message`/`AgentMessage` and is not
sent to the model.

## Why registered commands are not the problem

Pi checks extension commands before normal input processing. A command
registered like this is handled by the extension rather than submitted as a
user prompt:

```ts
pi.registerCommand("materia", {
  description: "Run Materia commands",
  handler: async (args, ctx) => {
    // Handle args without starting an agent turn.
  },
});
```

The command handler can still choose to perform an inference operation. For
example, `/materia cast <task>`, `/materia recast`, and `/materia continue`
intentionally dispatch a hidden Materia prompt. Read-only or administrative
commands such as `/materia budget`, `/materia status`, and `/materia grid` must
only update UI/session entries and notifications unless their contract
explicitly says otherwise.

## Two Pi APIs with different context semantics

### `appendEntry`: transcript-only custom entries

`pi.appendEntry(customType, data)` persists a custom session entry. Pi's
session context builder excludes custom entries from the message list sent to
the model. A custom entry can be rendered in the interactive transcript with
`pi.registerEntryRenderer(customType, renderer)`.

Both operations are required for a visible transcript-only card:

1. append the entry using the stable custom type; and
2. register a renderer for that type during extension initialization.

Materia's centralized API is:

```ts
import { appendMateriaPresentation } from "./presentation/materiaPresentation.js";

appendMateriaPresentation(pi, {
  content: "Current token limit: 100000",
  details: {
    prefix: "budget",
    materiaName: "orchestrator",
    eventType: "budget",
  },
});
```

`src/index.ts` calls `registerMateriaRenderer(pi)` once. The renderer handles
`pi-materia-presentation` entries and shares the card appearance with the
legacy message renderer. New commands and runtime paths should call
`appendMateriaPresentation`; they should not call `pi.appendEntry` with a new
card type or duplicate the renderer.

### `sendMessage`: context-bearing custom messages

`pi.sendMessage()` appends a custom message to the session and can trigger a
turn. The message content is available to the model and to Pi's context and
compaction machinery. `display: false` only hides the message from the normal
transcript display; it does **not** make the content private from the model.

For example, this is still model context and is not a display-only card:

```ts
pi.sendMessage({
  customType: "some-card",
  content: "This text is sent to the model",
  display: false,
});
```

Use `ctx.ui.notify()` for a transient notification and
`appendMateriaPresentation()` for a durable visible card. Neither one starts a
model turn.

## The intentional inference message

Materia dispatch uses one context-bearing custom message type:

```ts
pi.sendMessage({
  customType: "pi-materia-prompt",
  content: prompt,
  display: false,
  details: {
    phase,
    socketId,
    materiaName,
    finalization,
  },
}, { triggerTurn: true });
```

`pi-materia-prompt` is the hidden prompt that tells Pi to run the current
Materia socket. It is deliberately part of context so Pi's native retry,
compaction, and follow-up behavior can continue the intended turn. It is not a
status card and must not be replaced with a presentation entry.

The contract is therefore:

| Need | API | Model context | Starts inference |
| --- | --- | --- | --- |
| Transient user feedback | `ctx.ui.notify()` | No | No |
| Durable visible card | `appendMateriaPresentation()` | No | No |
| Run a Materia socket | `sendMessage({ customType: "pi-materia-prompt" }, { triggerTurn: true })` | Yes | Yes |

No other Materia display path should call `sendMessage` with
`customType: "pi-materia"` or `customType: "pi-materia-presentation"`.

## Context projection and legacy sessions

Older Materia releases emitted visible cards as `custom_message` entries with
`customType: "pi-materia"`. Those messages are already persisted in existing
sessions, so simply switching new code to presentation entries would not
remove their content from future prompts.

The single context boundary in `projectMateriaContext` applies these defenses
before active-cast isolation:

1. It removes legacy `role: "custom"` display messages with
   `customType: "pi-materia"` globally, including when there is no active cast
   and after a cast has completed.
2. It defensively removes a `pi-materia-presentation` value if a faulty adapter
   has reconstructed a presentation entry as a custom message. A real
   presentation entry never reaches this hook as a message.
3. When an active, failed, aborted, or paused Materia cast requires isolation,
   it anchors on that cast's `pi-materia-prompt`, prepends the synthetic cast
   context, and preserves only the prompt, relevant assistant/tool results,
   and genuine user refinement messages.

This keeps old display cards and unrelated transcript content out of ordinary
model turns as well as recast, revive, same-socket recovery, Pi-native retry,
compaction retry, and quest-linked reactivation paths.

## Recovery and replay guarantees

Presentation cards are UI data, not inference inputs:

- Recovery code may append another presentation card, but it must never turn a
  `pi-materia-presentation` entry back into a message.
- A retry that intentionally resumes inference reuses or dispatches the hidden
  `pi-materia-prompt`; it does not send the preceding status, transition,
  budget, quest, or text-output card.
- Pi's context hook filters legacy card messages on every context build, even
  for completed casts or ordinary non-Materia turns.
- Compaction and recovery operate on the projected context. Presentation
  entries are excluded by Pi before projection, and legacy card messages are
  removed by Materia's projection before the model request.

When adding a command or lifecycle event, decide explicitly which side of the
boundary it belongs to:

```ts
// Display-only: safe default for command results and runtime cards.
appendMateriaPresentation(pi, { content, details });

// Inference: only when this path is intentionally starting/continuing a cast.
pi.sendMessage(
  { customType: "pi-materia-prompt", content: prompt, display: false, details },
  { triggerTurn: true },
);
```

If the path only reports a result, it belongs in the first form.
