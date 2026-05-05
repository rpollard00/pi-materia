import type { ExtensionAPI, ExtensionContext, ExtensionHandler, SessionEntry } from "@mariozechner/pi-coding-agent";

export type FakeEventName = Parameters<ExtensionAPI["on"]>[0];

export interface FakeMessage {
  role: string;
  content: Array<{ type: "text"; text: string }>;
  [key: string]: unknown;
}

export interface FakeUiNotification {
  message: string;
  type?: "info" | "warning" | "error";
}

export interface FakeCommandContext extends ExtensionContext {
  waitForIdle(): Promise<void>;
}

let nextId = 1;

function entryBase(type: string, parentId: string | null): { type: string; id: string; parentId: string | null; timestamp: string } {
  return { type, id: `fake-${nextId++}`, parentId, timestamp: new Date().toISOString() };
}

export class FakeSessionManager {
  private readonly entries: SessionEntry[] = [];
  private leafId: string | null = null;

  constructor(private readonly cwd: string, private readonly sessionFile = `${cwd}/.fake-pi-session.jsonl`) {}

  getCwd(): string { return this.cwd; }
  getSessionDir(): string { return `${this.cwd}/.fake-pi-sessions`; }
  getSessionId(): string { return "fake-session"; }
  getSessionFile(): string { return this.sessionFile; }
  getLeafId(): string | null { return this.leafId; }
  getLeafEntry(): SessionEntry | undefined { return this.leafId ? this.getEntry(this.leafId) : undefined; }
  getEntry(id: string): SessionEntry | undefined { return this.entries.find((entry) => entry.id === id); }
  getLabel(): undefined { return undefined; }
  getHeader() { return { type: "session" as const, id: "fake-session", timestamp: new Date(0).toISOString(), cwd: this.cwd }; }
  getEntries(): SessionEntry[] { return [...this.entries]; }
  getBranch(): SessionEntry[] { return this.getEntries(); }
  getTree() { return this.entries.map((entry) => ({ entry, children: [] })); }
  getSessionName(): string | undefined { return undefined; }

  appendCustom<T>(customType: string, data?: T): SessionEntry {
    return this.append({ ...entryBase("custom", this.leafId), customType, data } as SessionEntry);
  }

  appendCustomMessage<T>(message: { customType: string; content: string | unknown[]; display: boolean; details?: T }): SessionEntry {
    return this.append({ ...entryBase("custom_message", this.leafId), ...message } as SessionEntry);
  }

  appendMessage(message: FakeMessage): SessionEntry {
    return this.append({ ...entryBase("message", this.leafId), message } as SessionEntry);
  }

  private append(entry: SessionEntry): SessionEntry {
    this.entries.push(entry);
    this.leafId = entry.id;
    return entry;
  }
}

export class FakePiHarness {
  readonly cwd: string;
  readonly sessionManager: FakeSessionManager;
  readonly pi: ExtensionAPI;
  readonly ctx: FakeCommandContext;
  readonly events = new Map<string, ExtensionHandler<any, any>[]>();
  readonly commands = new Map<string, { description?: string; handler: (args: string, ctx: FakeCommandContext) => Promise<void> }>();
  readonly flags = new Map<string, boolean | string | undefined>();
  readonly sentMessages: Array<{ message: unknown; options?: unknown }> = [];
  readonly userMessages: Array<{ content: unknown; options?: unknown }> = [];
  readonly appendedEntries: Array<{ customType: string; data?: unknown }> = [];
  readonly widgets = new Map<string, { content: string[] | undefined; options?: unknown }>();
  readonly notifications: FakeUiNotification[] = [];
  readonly statuses = new Map<string, string | undefined>();
  readonly registeredRenderers = new Map<string, unknown>();
  readonly setModelCalls: unknown[] = [];
  readonly setThinkingLevelCalls: string[] = [];
  readonly operationLog: string[] = [];
  readonly compactCalls: unknown[] = [];
  compactError: Error | undefined;
  waitForIdleCalls = 0;
  activeTools: string[] = ["read", "grep", "find", "ls", "bash", "edit", "write"];
  allTools: Array<{ name: string }> = this.activeTools.map((name) => ({ name }));
  models: Array<{ provider: string; id: string; name?: string; api?: string }> = [];
  activeModel: unknown;
  thinkingLevel = "none";
  sessionName: string | undefined;
  idle = true;

  constructor(cwd = process.cwd()) {
    this.cwd = cwd;
    this.sessionManager = new FakeSessionManager(cwd);
    this.pi = this.createPi();
    this.ctx = this.createContext();
  }

  private createPi(): ExtensionAPI {
    return {
      on: (event: string, handler: ExtensionHandler<any, any>) => {
        const handlers = this.events.get(event) ?? [];
        handlers.push(handler);
        this.events.set(event, handlers);
      },
      registerCommand: (name: string, options: { description?: string; handler: (args: string, ctx: FakeCommandContext) => Promise<void> }) => this.commands.set(name, options),
      registerFlag: (name: string, options: { default?: boolean | string }) => this.flags.set(name, options.default),
      getFlag: (name: string) => this.flags.get(name),
      registerMessageRenderer: (customType: string, renderer: unknown) => this.registeredRenderers.set(customType, renderer),
      sendMessage: (message: unknown, options?: unknown) => {
        if ((options as { triggerTurn?: boolean } | undefined)?.triggerTurn) this.operationLog.push("triggerTurn");
        this.sentMessages.push({ message, options });
        const custom = message as { customType?: string; content?: string | unknown[]; display?: boolean; details?: unknown };
        if (custom.customType) this.sessionManager.appendCustomMessage({ customType: custom.customType, content: custom.content ?? "", display: Boolean(custom.display), details: custom.details });
      },
      sendUserMessage: (content: unknown, options?: unknown) => this.userMessages.push({ content, options }),
      appendEntry: (customType: string, data?: unknown) => {
        this.appendedEntries.push({ customType, data });
        this.sessionManager.appendCustom(customType, data);
      },
      setSessionName: (name: string) => { this.sessionName = name; },
      getSessionName: () => this.sessionName,
      setLabel: () => undefined,
      exec: async () => ({ code: 0, stdout: "", stderr: "" }),
      getActiveTools: () => [...this.activeTools],
      getAllTools: () => [...this.allTools],
      setActiveTools: (toolNames: string[]) => { this.operationLog.push("setActiveTools"); this.activeTools = [...toolNames]; },
      getCommands: () => [],
      registerTool: () => undefined,
      registerShortcut: () => undefined,
      setModel: async (model: unknown) => { this.operationLog.push("setModel"); this.setModelCalls.push(model); this.activeModel = model; if (this.ctx) (this.ctx as unknown as { model: unknown }).model = model; return true; },
      getThinkingLevel: () => this.thinkingLevel,
      setThinkingLevel: (level: string) => { this.operationLog.push("setThinkingLevel"); this.setThinkingLevelCalls.push(level); this.thinkingLevel = level; },
      registerProvider: () => undefined,
    } as unknown as ExtensionAPI;
  }

  private createContext(): FakeCommandContext {
    return {
      ui: {
        select: async () => undefined,
        confirm: async () => true,
        input: async () => undefined,
        notify: (message: string, type?: "info" | "warning" | "error") => this.notifications.push({ message, type }),
        onTerminalInput: () => () => undefined,
        setStatus: (key: string, text: string | undefined) => this.statuses.set(key, text),
        setWorkingMessage: () => undefined,
        setWorkingVisible: () => undefined,
        setWorkingIndicator: () => undefined,
        setHiddenThinkingLabel: () => undefined,
        setWidget: (key: string, content: string[] | undefined, options?: unknown) => this.widgets.set(key, { content, options }),
        setFooter: () => undefined,
        setHeader: () => undefined,
        setTitle: () => undefined,
        custom: async () => undefined,
        pasteToEditor: () => undefined,
        setEditorText: () => undefined,
        getEditorText: () => "",
        editor: async () => undefined,
        addAutocompleteProvider: () => undefined,
        setEditorComponent: () => undefined,
        theme: {},
        getAllThemes: () => [],
        getTheme: () => undefined,
        setTheme: () => ({ success: true }),
        getToolsExpanded: () => true,
        setToolsExpanded: () => undefined,
      },
      hasUI: true,
      cwd: this.cwd,
      sessionManager: this.sessionManager,
      modelRegistry: {
        find: (provider: string, id: string) => this.models.find((model) => model.provider === provider && model.id === id),
        getAll: () => [...this.models],
      } as never,
      model: this.activeModel,
      isIdle: () => this.idle,
      signal: undefined,
      abort: () => undefined,
      hasPendingMessages: () => false,
      shutdown: () => undefined,
      getContextUsage: () => undefined,
      compact: (options?: { onComplete?: (result: unknown) => void; onError?: (error: Error) => void }) => {
        this.operationLog.push("compact");
        this.compactCalls.push(options);
        if (this.compactError) options?.onError?.(this.compactError);
        else options?.onComplete?.({ tokensBefore: 1000, tokensAfter: 100 });
      },
      getSystemPrompt: () => "",
      waitForIdle: async () => {
        this.waitForIdleCalls += 1;
      },
      newSession: async () => ({ cancelled: false }),
      fork: async () => ({ cancelled: false }),
      navigateTree: async () => ({ cancelled: false }),
    } as unknown as FakeCommandContext;
  }

  async emit(event: string, payload: unknown = {}): Promise<unknown[]> {
    const handlers = this.events.get(event) ?? [];
    const results: unknown[] = [];
    for (const handler of handlers) results.push(await handler(payload as never, this.ctx));
    return results;
  }

  async runCommand(name: string, args = ""): Promise<void> {
    const command = this.commands.get(name);
    if (!command) throw new Error(`Fake Pi command not registered: ${name}`);
    await command.handler(args, this.ctx);
  }

  appendAssistantMessage(text: string, extra: Record<string, unknown> = {}): SessionEntry {
    return this.sessionManager.appendMessage({ role: "assistant", content: [{ type: "text", text }], ...extra });
  }

  appendUserMessage(text: string): SessionEntry {
    return this.sessionManager.appendMessage({ role: "user", content: [{ type: "text", text }] });
  }
}
