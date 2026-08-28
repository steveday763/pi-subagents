import {
  type AgentSession,
  type AgentSessionEvent,
  type AgentSessionEventListener,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRecord } from "../src/types.js";
import {
  type NativeSessionActions,
  NativeSessionSwitcher,
} from "../src/ui/native-session-switcher.js";

type TestSession = AgentSession & {
  emit(event: AgentSessionEvent): void;
  allListeners(): AgentSessionEventListener[];
};

function testSession(
  id: string,
  options: { cwd?: string; streaming?: boolean; messages?: AgentSession["messages"] } = {},
): TestSession {
  const active = new Set<AgentSessionEventListener>();
  const all: AgentSessionEventListener[] = [];
  const messages = options.messages ?? [];
  const state = {
    messages,
    isStreaming: options.streaming ?? false,
    streamingMessage: undefined,
  };
  const session = {
    sessionId: id,
    messages,
    state,
    isStreaming: options.streaming ?? false,
    autoCompactionEnabled: true,
    sessionManager: { getCwd: () => options.cwd ?? `/repo/${id}` },
    subscribe: vi.fn((listener: AgentSessionEventListener) => {
      all.push(listener);
      active.add(listener);
      return () => active.delete(listener);
    }),
    emit: (event: AgentSessionEvent) => {
      for (const listener of [...active]) listener(event);
    },
    allListeners: () => all,
  };
  return session as unknown as TestSession;
}

class FakeInteractiveModeBase {
  version = "0.84.3";
  defaultEditor: {
    onSubmit?: (text: string) => void | Promise<void>;
    onEscape?: () => void;
    setText: ReturnType<typeof vi.fn>;
    addToHistory: ReturnType<typeof vi.fn>;
  };
  editor: FakeInteractiveModeBase["defaultEditor"];
  footer = {
    setSession: vi.fn(),
    setAutoCompactEnabled: vi.fn(),
    invalidate: vi.fn(),
  };
  footerDataProvider = {
    setCwd: vi.fn(),
    setExtensionStatus: vi.fn(),
  };
  settingsManager = { getShowTerminalProgress: vi.fn(() => true) };
  ui = { terminal: { setProgress: vi.fn() }, requestRender: vi.fn(), setFocus: vi.fn() };
  loadedResourcesContainer = { clear: vi.fn(), addChild: vi.fn() };
  chatContainer = { clear: vi.fn(), addChild: vi.fn() };
  pendingMessagesContainer = { clear: vi.fn(), addChild: vi.fn() };
  pendingTools = new Map<string, unknown>();
  compactionQueuedMessages: unknown[] = [];
  pendingBashComponents: unknown[] = [];
  bashComponent: unknown;
  isBashMode = false;
  streamingComponent: unknown;
  streamingMessage: unknown;
  unsubscribe?: () => void;
  workingVisible = true;
  renderedItems: AgentSession["messages"][] = [];
  handledEvents: AgentSessionEvent[] = [];
  originalSubmits: Array<{ text: string; session: AgentSession }> = [];
  warnings: string[] = [];
  errors: string[] = [];
  renderInitialCount = 0;
  renderRootCount = 0;
  autocompleteCount = 0;
  extensionCommands = new Set<string>();
  rootMethodCalls: string[] = [];

  constructor(public rootSession: AgentSession) {
    this.defaultEditor = {
      onSubmit: (text: string) => {
        this.originalSubmits.push({ text, session: Reflect.get(this, "session") as AgentSession });
      },
      setText: vi.fn(),
      addToHistory: vi.fn(),
    };
    this.editor = this.defaultEditor;
  }

  renderCurrentSessionState(): void {
    this.renderRootCount++;
    this.renderSessionItems((Reflect.get(this, "session") as AgentSession).messages);
    this.compactionQueuedMessages = [];
  }
  showLoadedResources(): void {}
  renderSessionItems(items: AgentSession["messages"]): void { this.renderedItems.push([...items]); }
  setupAutocompleteProvider(): void { this.autocompleteCount++; }
  updatePendingMessagesDisplay(): void {}
  updateTerminalTitle(): void {}
  updateEditorBorderColor(): void {}
  setWorkingVisible(): void {}
  clearStatusIndicator(): void {}
  isExtensionCommand(text: string): boolean { return this.extensionCommands.has(text); }
  async handleEvent(event: AgentSessionEvent): Promise<void> { this.handledEvents.push(event); }
  showWarning(message: string): void { this.warnings.push(message); }
  showError(message: string): void { this.errors.push(message); }
  handleClearCommand(): void { this.rootMethodCalls.push("new"); }
  showSessionSelector(): void { this.rootMethodCalls.push("resume"); }
  showTreeSelector(): void { this.rootMethodCalls.push("tree"); }
  showUserMessageSelector(): void { this.rootMethodCalls.push("fork"); }
}

function makeModeClass() {
  return class FakeInteractiveMode extends FakeInteractiveModeBase {
    get session(): AgentSession { return this.rootSession; }
    renderInitialMessages(): void { this.renderInitialCount++; }
  };
}

function record(session: AgentSession, over: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: "child-1",
    type: "general-purpose",
    handle: "general-purpose",
    description: "child",
    status: "completed",
    toolUses: 0,
    startedAt: Date.now(),
    session,
    lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
    compactionCount: 0,
    ...over,
  };
}

const queueEvent: AgentSessionEvent = { type: "queue_update", steering: [], followUp: [] };

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

describe("NativeSessionSwitcher", () => {
  const Mode = makeModeClass();
  const switcher = new NativeSessionSwitcher(Mode);
  let root: TestSession;
  let child: TestSession;
  let mode: InstanceType<typeof Mode>;
  let actions: NativeSessionActions;

  beforeEach(() => {
    root = testSession("root", { cwd: "/repo/root" });
    child = testSession("child", { cwd: "/repo/child", messages: [] });
    mode = new Mode(root);
    actions = {
      resume: vi.fn(async () => true),
      steer: vi.fn(() => true),
    };
    switcher.bind(actions);
    mode.unsubscribe = root.subscribe(event => { void mode.handleEvent(event); });
    mode.renderInitialMessages();
  });

  afterEach(() => {
    switcher.detach();
  });

  it("switches the native transcript, editor session and footer to a child", () => {
    const childRecord = record(child);
    switcher.showAgent(childRecord);

    expect(mode.session).toBe(child);
    expect(switcher.currentAgentId()).toBe("child-1");
    expect(mode.footer.setSession).toHaveBeenLastCalledWith(child);
    expect(mode.footerDataProvider.setCwd).toHaveBeenLastCalledWith("/repo/child");
    expect(mode.footerDataProvider.setExtensionStatus).toHaveBeenLastCalledWith(
      "pi-subagents:native-view",
      "viewing @general-purpose · general-purpose",
    );
    expect(mode.renderedItems.at(-1)).toEqual([]);
    expect(mode.ui.setFocus).toHaveBeenLastCalledWith(mode.editor);
  });

  it("routes only the selected session's live events", async () => {
    switcher.showAgent(record(child));
    const childListener = child.allListeners().at(-1);
    expect(childListener).toBeDefined();

    child.emit(queueEvent);
    await flush();
    expect(mode.handledEvents).toContain(queueEvent);

    switcher.showMain();
    const handled = mode.handledEvents.length;
    childListener?.(queueEvent);
    await flush();
    expect(mode.handledEvents).toHaveLength(handled);
  });

  it("restores the root transcript, footer and subscription", () => {
    switcher.showAgent(record(child));
    switcher.showMain();

    expect(mode.session).toBe(root);
    expect(switcher.currentAgentId()).toBeUndefined();
    expect(mode.renderRootCount).toBe(2);
    expect(mode.renderedItems.at(-1)).toEqual(root.messages);
    expect(mode.footer.setSession).toHaveBeenLastCalledWith(root);
    expect(mode.footerDataProvider.setExtensionStatus).toHaveBeenLastCalledWith(
      "pi-subagents:native-view",
      undefined,
    );
  });

  it("resumes a completed child without feeding the root input loop", async () => {
    const childRecord = record(child, { status: "completed" });
    switcher.showAgent(childRecord);
    mode.defaultEditor.onSubmit?.("continue here");
    await flush();

    expect(actions.resume).toHaveBeenCalledWith(childRecord, "continue here");
    expect(actions.steer).not.toHaveBeenCalled();
    expect(mode.originalSubmits).toEqual([]);
    expect(mode.editor.addToHistory).toHaveBeenCalledWith("continue here");
    expect(mode.editor.setText).toHaveBeenCalledWith("");
  });

  it("uses Pi's native streaming submit path for a running child", async () => {
    child = testSession("child", { streaming: true });
    const childRecord = record(child, { status: "running" });
    switcher.showAgent(childRecord);
    mode.defaultEditor.onSubmit?.("steer natively");
    await flush();

    expect(mode.originalSubmits).toEqual([{ text: "steer natively", session: child }]);
    expect(actions.resume).not.toHaveBeenCalled();
    expect(actions.steer).not.toHaveBeenCalled();
  });

  it("routes queued input through manager steering", async () => {
    const childRecord = record(child, { status: "queued" });
    switcher.showAgent(childRecord);
    mode.defaultEditor.onSubmit?.("change direction");
    await flush();

    expect(actions.steer).toHaveBeenCalledWith(childRecord, "change direction");
    expect(mode.originalSubmits).toEqual([]);
  });

  it("blocks root-session replacement commands while a child is selected", async () => {
    switcher.showAgent(record(child));
    mode.defaultEditor.onSubmit?.("/new");
    await flush();

    expect(mode.originalSubmits).toEqual([]);
    expect(mode.warnings).toEqual(["/new is available only on main. Switch to main and retry."]);
    expect(mode.editor.setText).toHaveBeenCalledWith("");
  });

  it("keeps child-local builtins on Pi's native command path", async () => {
    switcher.showAgent(record(child));
    mode.defaultEditor.onSubmit?.("/compact now");
    await flush();

    expect(mode.originalSubmits).toEqual([{ text: "/compact now", session: child }]);
  });

  it("resumes an idle child for extension commands instead of feeding the root input loop", async () => {
    const childRecord = record(child, { status: "completed" });
    mode.extensionCommands.add("/extension-command");
    switcher.showAgent(childRecord);
    mode.defaultEditor.onSubmit?.("/extension-command");
    await flush();

    expect(actions.resume).toHaveBeenCalledWith(childRecord, "/extension-command");
    expect(mode.originalSubmits).toEqual([]);
  });

  it("uses Pi's native compaction queue while the selected child is compacting", async () => {
    const childRecord = record(child, { status: "running" });
    switcher.showAgent(childRecord);
    Reflect.set(child, "isCompacting", true);
    mode.defaultEditor.onSubmit?.("after compact");
    await flush();

    expect(mode.originalSubmits).toEqual([{ text: "after compact", session: child }]);
    expect(actions.steer).not.toHaveBeenCalled();
  });

  it("blocks root replacement hotkeys while a child is selected", () => {
    switcher.showAgent(record(child));
    mode.showTreeSelector();

    expect(mode.rootMethodCalls).toEqual([]);
    expect(mode.warnings).toEqual(["/tree is available only on main. Switch to main and retry."]);

    switcher.showMain();
    mode.showTreeSelector();
    expect(mode.rootMethodCalls).toEqual(["tree"]);
  });

  it("keeps compaction and pending-bash UI state scoped to its session", () => {
    const rootQueue = [{ text: "after compact", mode: "steer" }];
    const rootBash = { kind: "bash" };
    mode.compactionQueuedMessages = rootQueue;
    mode.pendingBashComponents = [rootBash];
    root = Object.assign(root, { isStreaming: true });

    switcher.showAgent(record(child));
    expect(mode.compactionQueuedMessages).toEqual([]);
    expect(mode.pendingBashComponents).toEqual([]);

    switcher.showMain();
    expect(mode.compactionQueuedMessages).toBe(rootQueue);
    expect(mode.pendingBashComponents).toEqual([rootBash]);
    expect(mode.pendingMessagesContainer.addChild).toHaveBeenLastCalledWith(rootBash);
  });

  it.each([
    ["isBashRunning", "a bash command"],
    ["isCompacting", "compaction"],
    ["isRetrying", "an automatic retry"],
  ] as const)("refuses to leave a session during %s", (property, operation) => {
    Reflect.set(root, property, true);

    expect(() => switcher.showAgent(record(child))).toThrow(
      `Cannot switch: the current session is running ${operation}.`,
    );
    expect(mode.session).toBe(root);
  });

  it("catches asynchronous failures from Pi's native submit handler", async () => {
    const failure = new Error("native submit failed");
    mode.defaultEditor.onSubmit = vi.fn(async () => { throw failure; });
    mode.renderInitialMessages();
    switcher.showAgent(record(child));
    mode.defaultEditor.onSubmit?.("/compact now");
    await flush();

    expect(mode.errors).toEqual(["native submit failed"]);
  });

  it("restores the original editor callback on detach", () => {
    const original = mode.originalSubmits;
    switcher.detach();
    mode.defaultEditor.onSubmit?.("root again");

    expect(original).toEqual([{ text: "root again", session: root }]);
  });
});

describe("NativeSessionSwitcher ABI gate", () => {
  it("rejects an unverified Pi version instead of falling back", () => {
    const UnsupportedMode = makeModeClass();
    const switcher = new NativeSessionSwitcher(UnsupportedMode);
    const mode = new UnsupportedMode(testSession("root"));
    mode.version = "0.85.0";

    expect(() => mode.renderInitialMessages()).toThrow(
      "supports Pi 0.84.2 and 0.84.3; found 0.85.0. No fallback is enabled",
    );
    switcher.detach();
  });

  it("rejects a missing required instance field", () => {
    const BrokenMode = makeModeClass();
    const switcher = new NativeSessionSwitcher(BrokenMode);
    const mode = new BrokenMode(testSession("root"));
    Reflect.set(mode, "footer", undefined);

    expect(() => mode.renderInitialMessages()).toThrow(
      "incompatible InteractiveMode fields (footer). No fallback is enabled",
    );
    switcher.detach();
  });
});
