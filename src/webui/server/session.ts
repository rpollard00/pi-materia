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
