# Pi-Materia

Configurable, materia-themed agent pipelines for Pi: casts run loadouts of materia over sockets, optionally fanning out into parallel lanes.

## Language

**Fan-in**:
Ordered, accepted-only combination of a parallel run's branches at the barrier: the parent receives the ordered terminal outputs and opaque scope exports through `state.parallelFanIn` and advances along the loop's exit route. Fan-in never merges branch state or performs VCS integration.
_Avoid_: merge, combine state

**Lane recovery**:
Durable re-execution of failed or interrupted lanes of a parallel run, addressed by lane number. The parent cast stays at its barrier while lanes are recovered; accepted lanes are never rerun.
_Avoid_: branch revival, lane retry, lane resume

**Revive**:
Recovery (of a cast or a lane) that retains the existing session: the child session or parent state is restored and nudged forward without resending a prompt.
_Avoid_: resume (legacy spelling), restart

**Recast**:
Recovery (of a cast or a lane) that resends the prompt: the parent socket prompt is re-dispatched, or a fresh child cast is started for the same lane.
_Avoid_: retry, redo

**Lane number**:
Stable 1-based position of a lane in a parallel run's queue order. Lane numbers never renumber as sibling lanes complete or are recovered.
_Avoid_: lane index, lane position

**Status widget**:
The persistent below-editor panel (widget slot `materia`) showing a cast's run: current materia, loop turn, retry budget, usage, and live parallel lanes. Ownership is per session; a live run from another cast takes it over, while stale or terminal updates never do.
_Avoid_: status bar (the separate `setStatus` line), run panel
