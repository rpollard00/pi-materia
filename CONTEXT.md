# Pi-Materia

Configurable, materia-themed agent pipelines for Pi: casts run loadouts of materia over sockets, optionally fanning out into parallel lanes.

## Language

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
