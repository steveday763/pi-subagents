import {
  type AgentSession,
  type AgentSessionEvent,
  InteractiveMode,
} from "@earendil-works/pi-coding-agent";
import type { AgentRecord } from "../types.js";

const SUPPORTED_PI_VERSIONS = new Set(["0.84.2", "0.84.3"]);
const VIEW_STATUS_KEY = "pi-subagents:native-view";
const REGISTRY_KEY = Symbol.for("pi-subagents:native-session-switcher");

const ROOT_ONLY_COMMANDS = new Set([
  "/agents",
  "/clone",
  "/fork",
  "/import",
  "/new",
  "/reload",
  "/resume",
  "/tree",
]);

const BUILTIN_COMMANDS = new Set([
  "/arminsayshi",
  "/changelog",
  "/clone",
  "/compact",
  "/copy",
  "/debug",
  "/dementedelves",
  "/export",
  "/fork",
  "/hotkeys",
  "/import",
  "/login",
  "/logout",
  "/model",
  "/name",
  "/new",
  "/quit",
  "/reload",
  "/resume",
  "/scoped-models",
  "/session",
  "/settings",
  "/share",
  "/tree",
  "/trust",
]);

type NativeSubmit = (text: string) => void | Promise<void>;

interface NativeEditor {
  onSubmit?: NativeSubmit;
  setText(text: string): void;
  addToHistory?(text: string): void;
}

interface NativeFooter {
  setSession(session: AgentSession): void;
  setAutoCompactEnabled(enabled: boolean): void;
  invalidate(): void;
}

interface NativeFooterDataProvider {
  setCwd(cwd: string): void;
  setExtensionStatus(key: string, text: string | undefined): void;
}

interface NativeContainer {
  clear(): void;
  addChild(component: unknown): void;
}

interface NativeUI {
  terminal: { setProgress(active: boolean): void };
  requestRender(): void;
  setFocus(component: unknown): void;
}

interface NativeSettingsManager {
  getShowTerminalProgress(): boolean;
}

interface InteractiveModeInternals {
  version: string;
  readonly session: AgentSession;
  defaultEditor: NativeEditor;
  editor: NativeEditor;
  footer: NativeFooter;
  footerDataProvider: NativeFooterDataProvider;
  settingsManager: NativeSettingsManager;
  ui: NativeUI;
  loadedResourcesContainer: NativeContainer;
  chatContainer: NativeContainer;
  pendingMessagesContainer: NativeContainer;
  pendingTools: Map<string, unknown>;
  compactionQueuedMessages: unknown[];
  pendingBashComponents: unknown[];
  bashComponent: unknown;
  isBashMode: boolean;
  streamingComponent: unknown;
  streamingMessage: unknown;
  unsubscribe?: () => void;
  workingVisible: boolean;
  renderCurrentSessionState(): void;
  showLoadedResources(options: { force: boolean; showDiagnosticsWhenQuiet: boolean }): void;
  setupAutocompleteProvider(): void;
  updatePendingMessagesDisplay(): void;
  updateTerminalTitle(): void;
  updateEditorBorderColor(): void;
  setWorkingVisible(visible: boolean): void;
  clearStatusIndicator(kind?: string): void;
  handleEvent(event: AgentSessionEvent): Promise<void>;
  showWarning(message: string): void;
  showError(message: string): void;
}

interface InteractiveModeConstructor {
  prototype: object;
}

interface SessionUIState {
  compactionQueuedMessages: unknown[];
  pendingBashComponents: unknown[];
}

export interface NativeSessionActions {
  resume(record: AgentRecord, prompt: string): Promise<boolean>;
  steer(record: AgentRecord, prompt: string): boolean;
}

export interface NativeSessionView {
  currentAgentId(): string | undefined;
  showAgent(record: AgentRecord): void;
  showMain(): void;
}

function commandName(text: string): string {
  return text.split(/\s+/, 1)[0]?.toLowerCase() ?? "";
}

function requireMethod(prototype: object, name: string): void {
  if (typeof Reflect.get(prototype, name) !== "function") {
    throw new Error(
      `pi-subagents native session switch cannot start: InteractiveMode.${name} is unavailable. No fallback is enabled.`,
    );
  }
}

/**
 * Version-pinned bridge into Pi's native InteractiveMode.
 *
 * Pi does not expose a public live-session viewport API. This hook deliberately
 * fails closed when its verified ABI changes: silently reopening the old overlay
 * would make the UI claim that native switching is active when it is not.
 */
export class NativeSessionSwitcher implements NativeSessionView {
  private readonly originalSessionGetter: (this: object) => AgentSession;
  private readonly originalRenderInitialMessages: (this: object) => void;
  private mode: InteractiveModeInternals | undefined;
  private actions: NativeSessionActions | undefined;
  private selectedRecord: AgentRecord | undefined;
  private generation = 0;
  private readonly sessionUIStates = new WeakMap<AgentSession, SessionUIState>();
  private originalEditorSubmit: NativeSubmit | undefined;
  private wrappedEditorSubmit: NativeSubmit | undefined;

  constructor(modeClass: InteractiveModeConstructor = InteractiveMode) {
    const prototype = modeClass.prototype;
    const sessionDescriptor = Object.getOwnPropertyDescriptor(prototype, "session");
    const renderDescriptor = Object.getOwnPropertyDescriptor(prototype, "renderInitialMessages");
    if (typeof sessionDescriptor?.get !== "function") {
      throw new Error(
        "pi-subagents native session switch cannot start: InteractiveMode.session is unavailable. No fallback is enabled.",
      );
    }
    if (typeof renderDescriptor?.value !== "function") {
      throw new Error(
        "pi-subagents native session switch cannot start: InteractiveMode.renderInitialMessages is unavailable. No fallback is enabled.",
      );
    }
    for (const name of [
      "clearStatusIndicator",
      "handleEvent",
      "handleClearCommand",
      "renderCurrentSessionState",
      "setWorkingVisible",
      "showSessionSelector",
      "showTreeSelector",
      "showUserMessageSelector",
      "showLoadedResources",
      "setupAutocompleteProvider",
      "showError",
      "showWarning",
      "updateEditorBorderColor",
      "updatePendingMessagesDisplay",
      "updateTerminalTitle",
    ]) {
      requireMethod(prototype, name);
    }

    this.originalSessionGetter = sessionDescriptor.get as (this: object) => AgentSession;
    this.originalRenderInitialMessages = renderDescriptor.value as (this: object) => void;

    const switcher = this;
    Object.defineProperty(prototype, "session", {
      ...sessionDescriptor,
      get(this: object): AgentSession {
        return switcher.selectedSessionFor(this) ?? Reflect.apply(switcher.originalSessionGetter, this, []);
      },
    });
    Object.defineProperty(prototype, "renderInitialMessages", {
      ...renderDescriptor,
      value(this: object): void {
        Reflect.apply(switcher.originalRenderInitialMessages, this, []);
        switcher.capture(this);
      },
    });

    for (const [name, command] of [
      ["handleClearCommand", "/new"],
      ["showSessionSelector", "/resume"],
      ["showTreeSelector", "/tree"],
      ["showUserMessageSelector", "/fork"],
    ] as const) {
      const original = Reflect.get(prototype, name) as (...args: unknown[]) => unknown;
      Object.defineProperty(prototype, name, {
        configurable: true,
        writable: true,
        value(this: object, ...args: unknown[]): unknown {
          if (switcher.selectedSessionFor(this)) {
            (this as InteractiveModeInternals).showWarning(
              `${command} is available only on main. Switch to main and retry.`,
            );
            return undefined;
          }
          return Reflect.apply(original, this, args);
        },
      });
    }
  }

  bind(actions: NativeSessionActions): void {
    this.actions = actions;
  }

  /** Session shutdown path: remove hooks without touching the runtime being torn down. */
  detach(): void {
    this.generation++;
    this.mode?.unsubscribe?.();
    if (this.mode) this.restoreEditorSubmit(this.mode);
    this.mode = undefined;
    this.actions = undefined;
    this.selectedRecord = undefined;
  }

  currentAgentId(): string | undefined {
    return this.selectedRecord?.id;
  }

  showAgent(record: AgentRecord): void {
    const mode = this.requireCapturedMode();
    if (!this.actions) {
      throw new Error("Native subagent session controls are not bound to the active root session.");
    }
    if (!record.session) {
      throw new Error(`Agent ${record.id} has no live session to display.`);
    }
    if (this.selectedRecord?.id === record.id && this.selectedRecord.session === record.session) return;

    const currentSession = this.activeSession(mode);
    this.assertSessionCanSwitch(currentSession, "current");
    this.assertSessionCanSwitch(record.session, "target");
    this.saveSessionUIState(mode, currentSession);
    this.selectedRecord = record;
    this.activateSession(mode, record.session, false);
  }

  showMain(): void {
    const mode = this.mode;
    if (!mode || !this.selectedRecord) return;
    const currentSession = this.activeSession(mode);
    const rootSession = Reflect.apply(this.originalSessionGetter, mode, []);
    this.assertSessionCanSwitch(currentSession, "current");
    this.assertSessionCanSwitch(rootSession, "target");
    this.saveSessionUIState(mode, currentSession);
    this.selectedRecord = undefined;
    this.activateSession(mode, rootSession, true);
  }

  private selectedSessionFor(candidate: object): AgentSession | undefined {
    if (candidate !== this.mode) return undefined;
    return this.selectedRecord?.session;
  }

  private capture(candidate: object): void {
    const mode = candidate as InteractiveModeInternals;
    if (!SUPPORTED_PI_VERSIONS.has(mode.version)) {
      throw new Error(
        `pi-subagents native session switch supports Pi 0.84.2 and 0.84.3; found ${mode.version || "unknown"}. No fallback is enabled.`,
      );
    }
    this.validateInstance(mode);

    if (this.mode && this.mode !== mode) {
      this.generation++;
      this.mode.unsubscribe?.();
      this.restoreEditorSubmit(this.mode);
      this.selectedRecord = undefined;
    }
    this.mode = mode;
    this.installEditorSubmit(mode);
  }

  private validateInstance(mode: InteractiveModeInternals): void {
    const missing: string[] = [];
    if (!mode.defaultEditor || typeof mode.defaultEditor.setText !== "function") missing.push("defaultEditor");
    if (typeof mode.defaultEditor?.onSubmit !== "function") missing.push("defaultEditor.onSubmit");
    if (!mode.editor || typeof mode.editor.setText !== "function") missing.push("editor");
    if (!mode.footer || typeof mode.footer.setSession !== "function") missing.push("footer");
    if (!mode.footerDataProvider || typeof mode.footerDataProvider.setCwd !== "function") missing.push("footerDataProvider");
    if (!mode.settingsManager || typeof mode.settingsManager.getShowTerminalProgress !== "function") missing.push("settingsManager");
    if (!mode.ui || typeof mode.ui.requestRender !== "function" || typeof mode.ui.terminal?.setProgress !== "function") missing.push("ui");
    if (!(mode.pendingTools instanceof Map)) missing.push("pendingTools");
    if (!Array.isArray(mode.compactionQueuedMessages)) missing.push("compactionQueuedMessages");
    if (!Array.isArray(mode.pendingBashComponents)) missing.push("pendingBashComponents");
    if (missing.length > 0) {
      throw new Error(
        `pi-subagents native session switch cannot start: incompatible InteractiveMode fields (${missing.join(", ")}). No fallback is enabled.`,
      );
    }
  }

  private installEditorSubmit(mode: InteractiveModeInternals): void {
    if (this.wrappedEditorSubmit && mode.defaultEditor.onSubmit === this.wrappedEditorSubmit) {
      if (mode.editor !== mode.defaultEditor) mode.editor.onSubmit = this.wrappedEditorSubmit;
      return;
    }

    this.originalEditorSubmit = mode.defaultEditor.onSubmit;
    const wrapped: NativeSubmit = (text: string) => {
      void this.routeSubmit(mode, text).catch((error: unknown) => {
        mode.showError(error instanceof Error ? error.message : String(error));
      });
    };
    this.wrappedEditorSubmit = wrapped;
    mode.defaultEditor.onSubmit = wrapped;
    if (mode.editor !== mode.defaultEditor) mode.editor.onSubmit = wrapped;
  }

  private restoreEditorSubmit(mode: InteractiveModeInternals): void {
    if (!this.originalEditorSubmit || !this.wrappedEditorSubmit) return;
    if (mode.defaultEditor.onSubmit === this.wrappedEditorSubmit) {
      mode.defaultEditor.onSubmit = this.originalEditorSubmit;
    }
    if (mode.editor !== mode.defaultEditor && mode.editor.onSubmit === this.wrappedEditorSubmit) {
      mode.editor.onSubmit = this.originalEditorSubmit;
    }
    this.originalEditorSubmit = undefined;
    this.wrappedEditorSubmit = undefined;
  }

  private async routeSubmit(mode: InteractiveModeInternals, rawText: string): Promise<void> {
    const record = this.selectedRecord;
    const originalSubmit = this.originalEditorSubmit;
    if (!record?.session || !originalSubmit) {
      await originalSubmit?.(rawText);
      return;
    }

    const text = rawText.trim();
    if (!text) return;
    const command = commandName(text);
    if (ROOT_ONLY_COMMANDS.has(command)) {
      mode.editor.setText("");
      mode.showWarning(`${command} is available only on main. Switch to main and retry.`);
      return;
    }

    const isBuiltin = BUILTIN_COMMANDS.has(command) || (mode.version === "0.84.3" && command === "/thinking");
    if (text.startsWith("!") || isBuiltin) {
      await originalSubmit(text);
      return;
    }

    if (
      (record.status === "running" || record.status === "queued")
      && (record.session.isStreaming || record.session.isCompacting)
    ) {
      await originalSubmit(text);
      return;
    }

    mode.editor.addToHistory?.(text);
    mode.editor.setText("");
    if (record.status === "running" || record.status === "queued") {
      if (!this.actions?.steer(record, text)) {
        mode.showWarning(`Agent ${record.id} is no longer accepting input.`);
      }
      return;
    }

    const resumed = await this.actions?.resume(record, text);
    if (!resumed) mode.showWarning(`Agent ${record.id} could not be resumed.`);
  }

  private activateSession(mode: InteractiveModeInternals, session: AgentSession, main: boolean): void {
    const state = this.sessionUIStates.get(session) ?? {
      compactionQueuedMessages: [],
      pendingBashComponents: [],
    };
    const pendingBashComponents = session.isStreaming ? state.pendingBashComponents : [];
    this.sessionUIStates.set(session, { ...state, pendingBashComponents });
    mode.compactionQueuedMessages = state.compactionQueuedMessages;
    mode.pendingBashComponents = pendingBashComponents;
    mode.bashComponent = undefined;
    mode.isBashMode = false;
    mode.clearStatusIndicator();

    this.subscribe(mode, session);
    mode.footer.setSession(session);
    mode.footer.setAutoCompactEnabled(session.autoCompactionEnabled);
    mode.footerDataProvider.setCwd(session.sessionManager.getCwd());
    mode.footerDataProvider.setExtensionStatus(
      VIEW_STATUS_KEY,
      main ? undefined : this.viewLabel(this.selectedRecord),
    );

    mode.renderCurrentSessionState();
    // Pi resets this UI-only queue while rebuilding a transcript. Restore the
    // queue owned by the selected session so switching cannot drop or cross-route it.
    mode.compactionQueuedMessages = state.compactionQueuedMessages;
    mode.pendingBashComponents = pendingBashComponents;
    mode.showLoadedResources({ force: false, showDiagnosticsWhenQuiet: true });
    this.restoreStreamingMessage(mode, session);
    mode.setupAutocompleteProvider();
    mode.updatePendingMessagesDisplay();
    for (const component of pendingBashComponents) {
      mode.pendingMessagesContainer.addChild(component);
    }
    mode.updateEditorBorderColor();
    mode.updateTerminalTitle();
    if (session.isStreaming && mode.workingVisible) mode.setWorkingVisible(true);
    else mode.clearStatusIndicator("working");
    mode.ui.terminal.setProgress(
      mode.settingsManager.getShowTerminalProgress()
      && (session.isStreaming || session.isCompacting || session.isRetrying),
    );
    mode.footer.invalidate();
    mode.ui.setFocus(mode.editor);
    mode.ui.requestRender();
  }

  private subscribe(mode: InteractiveModeInternals, session: AgentSession): void {
    mode.unsubscribe?.();
    const generation = ++this.generation;
    mode.unsubscribe = session.subscribe((event) => {
      if (generation !== this.generation || this.activeSession(mode) !== session) return;
      void mode.handleEvent(event).catch((error: unknown) => {
        mode.showError(`Native subagent view event failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    });
  }

  private activeSession(mode: InteractiveModeInternals): AgentSession {
    return this.selectedRecord?.session ?? Reflect.apply(this.originalSessionGetter, mode, []);
  }

  private assertSessionCanSwitch(session: AgentSession, side: "current" | "target"): void {
    const busyOperation =
      session.isBashRunning ? "a bash command"
      : session.isCompacting ? "compaction"
      : session.isRetrying ? "an automatic retry"
      : undefined;
    if (busyOperation) {
      throw new Error(`Cannot switch: the ${side} session is running ${busyOperation}.`);
    }
  }

  private saveSessionUIState(mode: InteractiveModeInternals, session: AgentSession): void {
    this.sessionUIStates.set(session, {
      compactionQueuedMessages: mode.compactionQueuedMessages,
      pendingBashComponents: mode.pendingBashComponents,
    });
  }

  private restoreStreamingMessage(mode: InteractiveModeInternals, session: AgentSession): void {
    const streamingMessage = session.state.streamingMessage;
    if (!streamingMessage) return;
    void mode.handleEvent({ type: "message_start", message: streamingMessage }).catch((error: unknown) => {
      mode.showError(`Native subagent stream restore failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  private viewLabel(record: AgentRecord | undefined): string | undefined {
    if (!record) return undefined;
    const handle = record.alias ?? record.handle;
    return handle ? `viewing @${handle} · ${record.type}` : `viewing ${record.type}`;
  }

  private requireCapturedMode(): InteractiveModeInternals {
    if (!this.mode) {
      throw new Error(
        "Pi InteractiveMode has not been captured. Native subagent switching cannot continue; no fallback is enabled.",
      );
    }
    return this.mode;
  }
}

export function getNativeSessionSwitcher(): NativeSessionSwitcher {
  const registry = globalThis as unknown as Record<symbol, unknown>;
  const existing = registry[REGISTRY_KEY];
  if (existing) return existing as NativeSessionSwitcher;
  const switcher = new NativeSessionSwitcher();
  registry[REGISTRY_KEY] = switcher;
  return switcher;
}
