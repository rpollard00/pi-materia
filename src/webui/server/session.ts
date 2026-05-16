export interface MateriaMonitorArtifactEntry {
  socket?: string;
  materia?: string;
  phase?: string;
  kind?: string;
  artifact?: string;
  timestamp?: number;
  content?: string;
}

export interface MateriaMonitorEventEntry {
  ts?: number;
  type?: string;
  data?: unknown;
}

export interface MateriaToolRegistrySnapshot {
  ok: boolean;
  available: boolean;
  tools: string[];
  warnings?: string[];
}

export interface MateriaWebUiSessionSnapshot {
  ok: true;
  scope: 'session';
  service: 'pi-materia-webui';
  sessionKey: string;
  cwd: string;
  sessionFile: string;
  sessionId: string;
  uiStartedAt: number;
  now: number;
  emittedOutputs?: Array<{ id: string; type: string; text: string; timestamp?: number; socket?: string }>;
  /** Canonical runtime active loadout id/name for WebUI/TUI synchronization. */
  activeLoadoutId?: string;
  activeLoadout?: string;
  /** Additive live Pi tool registry metadata for editor affordances; omitted by older/fallback sessions. */
  toolRegistry?: MateriaToolRegistrySnapshot;
  artifactSummary?: {
    runDir?: string;
    request?: string;
    events: MateriaMonitorEventEntry[];
    outputs: MateriaMonitorArtifactEntry[];
    summary: string;
  };
  activeCast?: {
    castId: string;
    active: boolean;
    phase: string;
    currentSocketId?: string;
    currentMateria?: string;
    socketState?: string;
    awaitingResponse: boolean;
    runDir: string;
    artifactRoot: string;
    startedAt: number;
    updatedAt: number;
  };
}
