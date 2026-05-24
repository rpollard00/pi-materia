import { ok, type DomainIssue, type DomainResult } from "./result.js";

export const QUEST_BOARD_SCHEMA_VERSION = 1 as const;
export const QUEST_STATUSES = ["pending", "running", "succeeded", "failed", "blocked"] as const;
export type QuestStatus = (typeof QUEST_STATUSES)[number];
export type QuestTerminalStatus = Exclude<QuestStatus, "pending" | "running">;

export interface QuestRunnerState {
  enabled: boolean;
  activeQuestId?: string;
  lastStartedAt?: string;
  lastStoppedAt?: string;
}

export interface QuestRunResult {
  status: QuestTerminalStatus;
  castId: string;
  finishedAt: string;
  message?: string;
  error?: string;
  artifactDirectory?: string;
  runDirectory?: string;
  requestedLoadoutOverride?: string;
  effectiveLoadoutId?: string;
  effectiveLoadoutName?: string;
  effectiveLoadoutSource?: string;
  metadata?: Record<string, unknown>;
}

export interface QuestRunError {
  message: string;
  occurredAt: string;
  castId?: string;
  code?: string;
  metadata?: Record<string, unknown>;
}

export interface Quest {
  id: string;
  title: string;
  prompt: string;
  status: QuestStatus;
  createdAt: string;
  updatedAt: string;
  attempts: number;
  loadoutOverride?: string;
  currentCastId?: string;
  lastCastId?: string;
  lastResult?: QuestRunResult;
  lastError?: QuestRunError;
}

export interface QuestBoard {
  version: typeof QUEST_BOARD_SCHEMA_VERSION;
  createdAt: string;
  updatedAt: string;
  runner: QuestRunnerState;
  quests: Quest[];
}

export interface QuestClock {
  now(): string;
}

export interface CreateQuestBoardInput {
  now: string;
}

export interface AddQuestInput {
  id: string;
  title: string;
  prompt: string;
  now: string;
  loadoutOverride?: string;
}

export interface StartQuestInput {
  questId: string;
  castId: string;
  now: string;
}

export interface CompleteQuestInput {
  questId: string;
  castId: string;
  now: string;
  result: Omit<QuestRunResult, "castId" | "finishedAt"> & Partial<Pick<QuestRunResult, "castId" | "finishedAt">>;
}

export interface FailRunningQuestInput {
  questId: string;
  now: string;
  status?: Extract<QuestTerminalStatus, "failed" | "blocked">;
  castId?: string;
  message: string;
  code?: string;
  metadata?: Record<string, unknown>;
}

export interface RequeueQuestInput {
  questId: string;
  now: string;
}

export interface DeleteQuestInput {
  questId: string;
  now: string;
}

export interface UpdatePendingQuestInput {
  questId: string;
  title: string;
  prompt: string;
  now: string;
  loadoutOverride?: string;
}

export type QuestMovePlacement = "first" | "before" | "after";

export const QUEST_ID_PREFIX = "quest-";
export const DEFAULT_RANDOM_QUEST_ID_LENGTH = 8;
export const DEFAULT_QUEST_ID_MAX_ATTEMPTS = 64;

export interface GenerateQuestIdOptions {
  nextId?: () => string;
  maxAttempts?: number;
}

export interface MovePendingQuestInput {
  questId: string;
  placement: QuestMovePlacement;
  targetId?: string;
  now?: string;
}

export function createQuestBoard(input: CreateQuestBoardInput): QuestBoard {
  return {
    version: QUEST_BOARD_SCHEMA_VERSION,
    createdAt: input.now,
    updatedAt: input.now,
    runner: { enabled: false },
    quests: [],
  };
}

export const createEmptyQuestBoard = createQuestBoard;

export function createShortRandomQuestId(length = DEFAULT_RANDOM_QUEST_ID_LENGTH): string {
  const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz";
  let randomPart = "";
  for (let index = 0; index < length; index += 1) {
    randomPart += alphabet[Math.floor(Math.random() * alphabet.length)] ?? "0";
  }
  return `${QUEST_ID_PREFIX}${randomPart}`;
}

export function generateUniqueQuestId(board: QuestBoard, options: GenerateQuestIdOptions = {}): DomainResult<string> {
  const nextId = options.nextId ?? createShortRandomQuestId;
  const maxAttempts = options.maxAttempts ?? DEFAULT_QUEST_ID_MAX_ATTEMPTS;
  const existingIds = new Set(board.quests.map((quest) => quest.id));
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const candidate = nextId();
    if (!isNonEmptyString(candidate)) return issue("quest.id", "generated quest id must be non-empty");
    if (!existingIds.has(candidate)) return ok(candidate);
  }
  return issue("quest.id", `could not generate a unique quest id after ${maxAttempts} attempts`);
}

export function resolveQuestRef(board: QuestBoard, ref: string): DomainResult<Quest> {
  const trimmed = ref.trim();
  if (!trimmed) return issue("questRef", "quest reference is required");

  const exact = board.quests.find((quest) => quest.id === trimmed);
  if (exact !== undefined) return ok(exact);

  const matches = board.quests.filter((quest) => quest.id.startsWith(trimmed) || (quest.id.startsWith(QUEST_ID_PREFIX) && quest.id.slice(QUEST_ID_PREFIX.length).startsWith(trimmed)));
  if (matches.length === 1) return ok(matches[0]!);
  if (matches.length === 0) return issue("questRef", `no quest matches reference '${trimmed}'`);

  const listed = matches.slice(0, 8).map((quest) => quest.id).join(", ");
  const suffix = matches.length > 8 ? `, and ${matches.length - 8} more` : "";
  return issue("questRef", `quest reference '${trimmed}' is ambiguous; matches: ${listed}${suffix}`);
}

export function addQuest(board: QuestBoard, input: AddQuestInput): DomainResult<QuestBoard> {
  const issues: DomainIssue[] = [];
  if (!isNonEmptyString(input.id)) issues.push({ path: "quest.id", message: "id is required" });
  if (!isNonEmptyString(input.title)) issues.push({ path: "quest.title", message: "title is required" });
  if (!isNonEmptyString(input.prompt)) issues.push({ path: "quest.prompt", message: "prompt is required" });
  if (!isNonEmptyString(input.now)) issues.push({ path: "quest.now", message: "timestamp is required" });
  if (board.quests.some((quest) => quest.id === input.id)) issues.push({ path: "quest.id", message: `quest '${input.id}' already exists` });
  if (input.loadoutOverride !== undefined && !isNonEmptyString(input.loadoutOverride)) issues.push({ path: "quest.loadoutOverride", message: "loadout override must be non-empty when provided" });
  if (issues.length > 0) return { ok: false, issues };

  const quest: Quest = {
    id: input.id,
    title: input.title,
    prompt: input.prompt,
    status: "pending",
    createdAt: input.now,
    updatedAt: input.now,
    attempts: 0,
    ...(input.loadoutOverride !== undefined ? { loadoutOverride: input.loadoutOverride } : {}),
  };

  return ok({ ...board, updatedAt: input.now, quests: [...board.quests, quest] });
}

export function updatePendingQuest(board: QuestBoard, input: UpdatePendingQuestInput): DomainResult<QuestBoard> {
  const normalized = normalizeQuestBoard(board);
  if (!normalized.ok) return normalized;

  const issues: DomainIssue[] = [];
  if (!isNonEmptyString(input.title)) issues.push({ path: "quest.title", message: "title is required" });
  if (!isNonEmptyString(input.prompt)) issues.push({ path: "quest.prompt", message: "prompt is required" });
  if (!isNonEmptyString(input.now)) issues.push({ path: "quest.now", message: "timestamp is required" });
  if (input.loadoutOverride !== undefined && !isNonEmptyString(input.loadoutOverride)) issues.push({ path: "quest.loadoutOverride", message: "loadout override must be non-empty when provided" });

  const questIndex = normalized.value.quests.findIndex((quest) => quest.id === input.questId);
  const quest = questIndex >= 0 ? normalized.value.quests[questIndex] : undefined;
  if (quest === undefined) {
    issues.push({ path: "questId", message: `quest '${input.questId}' does not exist` });
  } else if (quest.status !== "pending") {
    issues.push({ path: "quest.status", message: `quest '${quest.id}' is ${quest.status}, not pending` });
  }

  if (issues.length > 0) return { ok: false, issues };

  const { loadoutOverride, ...rest } = quest!;
  void loadoutOverride;
  const nextQuest: Quest = {
    ...rest,
    title: input.title,
    prompt: input.prompt,
    updatedAt: input.now,
    ...(input.loadoutOverride !== undefined ? { loadoutOverride: input.loadoutOverride } : {}),
  };
  const nextBoard: QuestBoard = { ...normalized.value, updatedAt: input.now, quests: replaceAt(normalized.value.quests, questIndex, nextQuest) };
  const validated = validateQuestBoard(nextBoard);
  if (!validated.ok) return validated;
  return ok(nextBoard);
}

export function enableQuestRunner(board: QuestBoard, now: string): QuestBoard {
  return {
    ...board,
    updatedAt: now,
    runner: { ...board.runner, enabled: true, lastStartedAt: now, lastStoppedAt: undefined },
  };
}

export function stopQuestRunner(board: QuestBoard, now: string): QuestBoard {
  return {
    ...board,
    updatedAt: now,
    runner: { ...board.runner, enabled: false, lastStoppedAt: now },
  };
}

export function normalizeQuestBoard(board: QuestBoard): DomainResult<QuestBoard> {
  const validated = validateQuestBoard(board, "questBoard");
  if (!validated.ok) return validated;

  // QuestBoard.quests is an array, so its relative pending-quest order is the
  // only persisted pending-order source. Normalization intentionally preserves
  // that visible order and does not write a parallel order list that could drift.
  return ok({
    version: validated.value.version,
    createdAt: validated.value.createdAt,
    updatedAt: validated.value.updatedAt,
    runner: { ...validated.value.runner },
    quests: validated.value.quests.slice(),
  });
}

export function getOrderedQuestView(board: QuestBoard): Quest[] {
  const activeQuest = getActiveQuest(board);
  const pendingQuests = board.quests.filter((quest) => quest.status === "pending");
  return activeQuest === undefined ? pendingQuests : [activeQuest, ...pendingQuests.filter((quest) => quest.id !== activeQuest.id)];
}

export function findNextPendingQuest(board: QuestBoard): Quest | undefined {
  return board.quests.find((quest) => quest.status === "pending");
}

export function movePendingQuest(board: QuestBoard, input: MovePendingQuestInput): DomainResult<QuestBoard> {
  const normalized = normalizeQuestBoard(board);
  if (!normalized.ok) return normalized;

  const issues: DomainIssue[] = [];
  const source = normalized.value.quests.find((quest) => quest.id === input.questId);
  if (source === undefined) issues.push({ path: "questId", message: `quest '${input.questId}' does not exist` });
  else if (source.status !== "pending") issues.push({ path: "quest.status", message: `quest '${source.id}' is ${source.status}, not pending` });

  if (!isMovePlacement(input.placement)) {
    issues.push({ path: "placement", message: "placement must be first, before, or after" });
  }

  const needsTarget = input.placement === "before" || input.placement === "after";
  if (input.placement === "first" && input.targetId !== undefined) {
    issues.push({ path: "targetId", message: "target id is not allowed when placement is first" });
  } else if (needsTarget && input.targetId === undefined) {
    issues.push({ path: "targetId", message: `target id is required when placement is ${input.placement}` });
  }

  let target: Quest | undefined;
  if (input.targetId !== undefined) {
    target = normalized.value.quests.find((quest) => quest.id === input.targetId);
    if (target === undefined) issues.push({ path: "targetId", message: `quest '${input.targetId}' does not exist` });
    else if (target.status !== "pending") issues.push({ path: "target.status", message: `quest '${target.id}' is ${target.status}, not pending` });
    if (input.targetId === input.questId) issues.push({ path: "targetId", message: "target quest must be different from moved quest" });
  }

  if (issues.length > 0) return { ok: false, issues };

  const pendingIds = normalized.value.quests.filter((quest) => quest.status === "pending").map((quest) => quest.id);
  const reorderedPendingIds = pendingIds.filter((id) => id !== input.questId);
  let insertIndex = 0;
  if (input.placement === "before" || input.placement === "after") {
    const targetIndex = reorderedPendingIds.indexOf(input.targetId!);
    insertIndex = input.placement === "after" ? targetIndex + 1 : targetIndex;
  }
  reorderedPendingIds.splice(insertIndex, 0, input.questId);

  if (sameOrder(pendingIds, reorderedPendingIds)) return ok(normalized.value);

  const pendingById = new Map(normalized.value.quests.filter((quest) => quest.status === "pending").map((quest) => [quest.id, quest]));
  const reorderedPendingQuests = reorderedPendingIds.map((id) => pendingById.get(id)).filter((quest): quest is Quest => quest !== undefined);
  let nextPendingIndex = 0;
  const quests = normalized.value.quests.map((quest) => {
    if (quest.status !== "pending") return quest;
    const nextQuest = reorderedPendingQuests[nextPendingIndex];
    nextPendingIndex += 1;
    return nextQuest ?? quest;
  });

  return ok({ ...normalized.value, updatedAt: input.now ?? normalized.value.updatedAt, quests });
}

export function startQuest(board: QuestBoard, input: StartQuestInput): DomainResult<QuestBoard> {
  const questIndex = board.quests.findIndex((quest) => quest.id === input.questId);
  if (questIndex < 0) return issue("questId", `quest '${input.questId}' does not exist`);
  const runningQuest = board.quests.find((quest) => quest.status === "running");
  if (runningQuest !== undefined) return issue("quests", `quest '${runningQuest.id}' is already running`);
  if (board.runner.activeQuestId !== undefined) return issue("runner.activeQuestId", `runner already has active quest '${board.runner.activeQuestId}'`);

  const quest = board.quests[questIndex];
  if (quest === undefined) return issue("questId", `quest '${input.questId}' does not exist`);
  if (quest.status !== "pending") return issue("quest.status", `quest '${quest.id}' is ${quest.status}, not pending`);
  if (!isNonEmptyString(input.castId)) return issue("castId", "cast id is required");

  const nextQuest: Quest = {
    ...quest,
    status: "running",
    updatedAt: input.now,
    attempts: quest.attempts + 1,
    currentCastId: input.castId,
    lastCastId: input.castId,
    lastError: undefined,
  };
  const quests = replaceAt(board.quests, questIndex, nextQuest);
  return ok({ ...board, updatedAt: input.now, runner: { ...board.runner, activeQuestId: quest.id }, quests });
}

export function completeQuest(board: QuestBoard, input: CompleteQuestInput): DomainResult<QuestBoard> {
  const questIndex = board.quests.findIndex((quest) => quest.id === input.questId);
  if (questIndex < 0) return issue("questId", `quest '${input.questId}' does not exist`);
  const quest = board.quests[questIndex];
  if (quest === undefined) return issue("questId", `quest '${input.questId}' does not exist`);
  if (quest.status !== "running") return issue("quest.status", `quest '${quest.id}' is ${quest.status}, not running`);
  if (quest.currentCastId !== input.castId) return issue("castId", `cast id does not match running quest '${quest.id}'`);
  if (!isQuestTerminalStatus(input.result.status)) return issue("result.status", "result status must be succeeded, failed, or blocked");

  const result: QuestRunResult = {
    ...input.result,
    status: input.result.status,
    castId: input.result.castId ?? input.castId,
    finishedAt: input.result.finishedAt ?? input.now,
  };
  if (result.castId !== input.castId) return issue("result.castId", "result cast id must match the completed cast id");

  const nextQuest: Quest = {
    ...quest,
    status: result.status,
    updatedAt: input.now,
    currentCastId: undefined,
    lastCastId: input.castId,
    lastResult: result,
    lastError: result.status === "succeeded" ? undefined : { message: result.error ?? result.message ?? `quest ${result.status}`, occurredAt: result.finishedAt, castId: input.castId },
  };
  const quests = replaceAt(board.quests, questIndex, nextQuest);
  return ok({
    ...board,
    updatedAt: input.now,
    runner: { ...board.runner, activeQuestId: board.runner.activeQuestId === quest.id ? undefined : board.runner.activeQuestId },
    quests,
  });
}

export function failRunningQuest(board: QuestBoard, input: FailRunningQuestInput): DomainResult<QuestBoard> {
  const questIndex = board.quests.findIndex((quest) => quest.id === input.questId);
  if (questIndex < 0) return issue("questId", `quest '${input.questId}' does not exist`);
  const quest = board.quests[questIndex];
  if (quest === undefined) return issue("questId", `quest '${input.questId}' does not exist`);
  if (quest.status !== "running") return issue("quest.status", `quest '${quest.id}' is ${quest.status}, not running`);
  if (input.castId !== undefined && quest.currentCastId !== input.castId) return issue("castId", `cast id does not match running quest '${quest.id}'`);

  const status = input.status ?? "failed";
  const castId = input.castId ?? quest.currentCastId;
  const lastError: QuestRunError = { message: input.message, occurredAt: input.now, ...(castId !== undefined ? { castId } : {}), ...(input.code !== undefined ? { code: input.code } : {}), ...(input.metadata !== undefined ? { metadata: input.metadata } : {}) };
  const lastResult: QuestRunResult | undefined = castId !== undefined ? { status, castId, finishedAt: input.now, error: input.message, ...(input.metadata !== undefined ? { metadata: input.metadata } : {}) } : quest.lastResult;
  const nextQuest: Quest = { ...quest, status, updatedAt: input.now, currentCastId: undefined, ...(castId !== undefined ? { lastCastId: castId } : {}), lastError, ...(lastResult !== undefined ? { lastResult } : {}) };
  const quests = replaceAt(board.quests, questIndex, nextQuest);
  return ok({ ...board, updatedAt: input.now, runner: { ...board.runner, activeQuestId: board.runner.activeQuestId === quest.id ? undefined : board.runner.activeQuestId }, quests });
}

export function deleteQuest(board: QuestBoard, input: DeleteQuestInput): DomainResult<QuestBoard> {
  const normalized = normalizeQuestBoard(board);
  if (!normalized.ok) return normalized;

  const issues: DomainIssue[] = [];
  if (!isNonEmptyString(input.questId)) issues.push({ path: "questId", message: "quest id is required" });
  if (!isNonEmptyString(input.now)) issues.push({ path: "quest.now", message: "timestamp is required" });

  const quest = normalized.value.quests.find((candidate) => candidate.id === input.questId);
  if (quest === undefined) {
    issues.push({ path: "questId", message: `quest '${input.questId}' does not exist` });
  } else {
    if (quest.status === "running") issues.push({ path: "quest.status", message: `quest '${quest.id}' is running and cannot be deleted` });
    if (normalized.value.runner.activeQuestId === quest.id) issues.push({ path: "runner.activeQuestId", message: `quest '${quest.id}' is the active quest and cannot be deleted` });
  }

  if (issues.length > 0) return { ok: false, issues };

  const quests = normalized.value.quests.filter((candidate) => candidate.id !== input.questId);
  const nextBoard: QuestBoard = { ...normalized.value, updatedAt: input.now, quests };
  const validated = validateQuestBoard(nextBoard);
  if (!validated.ok) return validated;
  return ok(nextBoard);
}

export function requeueQuest(board: QuestBoard, input: RequeueQuestInput): DomainResult<QuestBoard> {
  const issues: DomainIssue[] = [];
  if (!isNonEmptyString(input.now)) issues.push({ path: "quest.now", message: "timestamp is required" });

  const questIndex = board.quests.findIndex((quest) => quest.id === input.questId);
  const quest = questIndex >= 0 ? board.quests[questIndex] : undefined;
  if (quest === undefined) {
    issues.push({ path: "questId", message: `quest '${input.questId}' does not exist` });
  } else if (quest.status !== "failed" && quest.status !== "blocked") {
    issues.push({ path: "quest.status", message: `quest '${quest.id}' is ${quest.status}, not failed or blocked` });
  }

  if (issues.length > 0) return { ok: false, issues };

  const { currentCastId, ...rest } = quest!;
  void currentCastId;
  const nextQuest: Quest = { ...rest, status: "pending", updatedAt: input.now };
  const quests = [...board.quests.filter((_, index) => index !== questIndex), nextQuest];
  const nextBoard: QuestBoard = { ...board, updatedAt: input.now, quests };
  const validated = validateQuestBoard(nextBoard);
  if (!validated.ok) return validated;
  return ok(nextBoard);
}

export function validateQuestBoard(value: unknown, path = "questBoard"): DomainResult<QuestBoard> {
  const issues: DomainIssue[] = [];
  if (!isPlainObject(value)) return { ok: false, issues: [{ path, message: "quest board must be an object" }] };

  if (value.version !== QUEST_BOARD_SCHEMA_VERSION) issues.push({ path: `${path}.version`, message: `version must be ${QUEST_BOARD_SCHEMA_VERSION}` });
  requireString(value.createdAt, `${path}.createdAt`, issues);
  requireString(value.updatedAt, `${path}.updatedAt`, issues);
  validateRunner(value.runner, `${path}.runner`, issues);
  if (!Array.isArray(value.quests)) {
    issues.push({ path: `${path}.quests`, message: "quests must be an array" });
  } else {
    value.quests.forEach((quest, index) => validateQuest(quest, `${path}.quests.${index}`, issues));
    validateQuestCollection(value.quests, `${path}.quests`, issues);
    const runner = value.runner;
    if (isPlainObject(runner) && typeof runner.activeQuestId === "string") {
      const activeQuestId = runner.activeQuestId;
      const active = value.quests.find((quest) => isPlainObject(quest) && quest.id === activeQuestId);
      if (active === undefined) issues.push({ path: `${path}.runner.activeQuestId`, message: "active quest id must reference an existing quest" });
      else if (isPlainObject(active) && active.status !== "running") issues.push({ path: `${path}.runner.activeQuestId`, message: "active quest must be running" });
    }
  }

  if (issues.length > 0) return { ok: false, issues };
  return ok(value as unknown as QuestBoard);
}

export function isQuestStatus(value: unknown): value is QuestStatus {
  return typeof value === "string" && (QUEST_STATUSES as readonly string[]).includes(value);
}

export function isQuestTerminalStatus(value: unknown): value is QuestTerminalStatus {
  return value === "succeeded" || value === "failed" || value === "blocked";
}

function validateRunner(value: unknown, path: string, issues: DomainIssue[]): void {
  if (!isPlainObject(value)) {
    issues.push({ path, message: "runner must be an object" });
    return;
  }
  if (typeof value.enabled !== "boolean") issues.push({ path: `${path}.enabled`, message: "enabled must be a boolean" });
  optionalString(value.activeQuestId, `${path}.activeQuestId`, issues);
  optionalString(value.lastStartedAt, `${path}.lastStartedAt`, issues);
  optionalString(value.lastStoppedAt, `${path}.lastStoppedAt`, issues);
}

function validateQuest(value: unknown, path: string, issues: DomainIssue[]): void {
  if (!isPlainObject(value)) {
    issues.push({ path, message: "quest must be an object" });
    return;
  }
  requireString(value.id, `${path}.id`, issues);
  requireString(value.title, `${path}.title`, issues);
  requireString(value.prompt, `${path}.prompt`, issues);
  if (!isQuestStatus(value.status)) issues.push({ path: `${path}.status`, message: "status must be pending, running, succeeded, failed, or blocked" });
  requireString(value.createdAt, `${path}.createdAt`, issues);
  requireString(value.updatedAt, `${path}.updatedAt`, issues);
  if (typeof value.attempts !== "number" || !Number.isInteger(value.attempts) || value.attempts < 0) issues.push({ path: `${path}.attempts`, message: "attempts must be a non-negative integer" });
  optionalString(value.loadoutOverride, `${path}.loadoutOverride`, issues);
  optionalString(value.currentCastId, `${path}.currentCastId`, issues);
  optionalString(value.lastCastId, `${path}.lastCastId`, issues);
  if (value.status === "running" && typeof value.currentCastId !== "string") issues.push({ path: `${path}.currentCastId`, message: "running quest must have a current cast id" });
  if (value.status !== "running" && value.currentCastId !== undefined) issues.push({ path: `${path}.currentCastId`, message: "only running quests may have a current cast id" });
  if (value.lastResult !== undefined) validateRunResult(value.lastResult, `${path}.lastResult`, issues);
  if (value.lastError !== undefined) validateRunError(value.lastError, `${path}.lastError`, issues);
}

function validateQuestCollection(quests: unknown[], path: string, issues: DomainIssue[]): void {
  const ids = new Set<string>();
  let runningCount = 0;
  for (let index = 0; index < quests.length; index += 1) {
    const quest = quests[index];
    if (!isPlainObject(quest)) continue;
    if (typeof quest.id === "string") {
      if (ids.has(quest.id)) issues.push({ path: `${path}.${index}.id`, message: `duplicate quest id '${quest.id}'` });
      ids.add(quest.id);
    }
    if (quest.status === "running") runningCount += 1;
  }
  if (runningCount > 1) issues.push({ path, message: "at most one quest may be running" });
}

function validateRunResult(value: unknown, path: string, issues: DomainIssue[]): void {
  if (!isPlainObject(value)) {
    issues.push({ path, message: "run result must be an object" });
    return;
  }
  if (!isQuestTerminalStatus(value.status)) issues.push({ path: `${path}.status`, message: "status must be succeeded, failed, or blocked" });
  requireString(value.castId, `${path}.castId`, issues);
  requireString(value.finishedAt, `${path}.finishedAt`, issues);
  optionalString(value.message, `${path}.message`, issues);
  optionalString(value.error, `${path}.error`, issues);
  optionalString(value.artifactDirectory, `${path}.artifactDirectory`, issues);
  optionalString(value.runDirectory, `${path}.runDirectory`, issues);
  optionalString(value.requestedLoadoutOverride, `${path}.requestedLoadoutOverride`, issues);
  optionalString(value.effectiveLoadoutId, `${path}.effectiveLoadoutId`, issues);
  optionalString(value.effectiveLoadoutName, `${path}.effectiveLoadoutName`, issues);
  optionalString(value.effectiveLoadoutSource, `${path}.effectiveLoadoutSource`, issues);
  if (value.metadata !== undefined && !isPlainObject(value.metadata)) issues.push({ path: `${path}.metadata`, message: "metadata must be an object when provided" });
}

function validateRunError(value: unknown, path: string, issues: DomainIssue[]): void {
  if (!isPlainObject(value)) {
    issues.push({ path, message: "run error must be an object" });
    return;
  }
  requireString(value.message, `${path}.message`, issues);
  requireString(value.occurredAt, `${path}.occurredAt`, issues);
  optionalString(value.castId, `${path}.castId`, issues);
  optionalString(value.code, `${path}.code`, issues);
  if (value.metadata !== undefined && !isPlainObject(value.metadata)) issues.push({ path: `${path}.metadata`, message: "metadata must be an object when provided" });
}

function requireString(value: unknown, path: string, issues: DomainIssue[]): void {
  if (!isNonEmptyString(value)) issues.push({ path, message: "must be a non-empty string" });
}

function optionalString(value: unknown, path: string, issues: DomainIssue[]): void {
  if (value !== undefined && !isNonEmptyString(value)) issues.push({ path, message: "must be a non-empty string when provided" });
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function replaceAt<T>(items: readonly T[], index: number, value: T): T[] {
  return items.map((item, itemIndex) => (itemIndex === index ? value : item));
}

function getActiveQuest(board: QuestBoard): Quest | undefined {
  if (board.runner.activeQuestId !== undefined) {
    const active = board.quests.find((quest) => quest.id === board.runner.activeQuestId);
    if (active !== undefined) return active;
  }
  return board.quests.find((quest) => quest.status === "running");
}

function isMovePlacement(value: unknown): value is QuestMovePlacement {
  return value === "first" || value === "before" || value === "after";
}

function sameOrder(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function issue(path: string, message: string): DomainResult<never> {
  return { ok: false, issues: [{ path, message }] };
}
