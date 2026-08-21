import * as vscode from "vscode";
import { GoldenText, Normalizer } from "./golden";
import { DapTrackerFactory, Logger, SessionTracker, Stopped, withTimeout } from "./dapTracker";

const EXT_ID = "example-publisher.vscode-py-debug";

/** A breakpoint to set through the VS Code UI model. `line` is 1-based, matching
 *  the editor. */
export interface BpSpec {
  line: number;
  condition?: string;
  hitCondition?: string;
  logMessage?: string;
}

/** One observed pause: which session stopped, its tracker, and the stop info. */
export interface Pause {
  session: vscode.DebugSession;
  tracker: SessionTracker;
  stopped: Stopped;
}

/**
 * The `TestP`/`TestRoot` analog for our architecture. It drives the *real* user
 * path — set breakpoints through the VS Code UI model, open a Python Debug
 * Terminal via our command, run a fixture in it — and observes the debugpy
 * session(s) that our rendezvous pipeline spins up, exposing pauses/frames/
 * breakpoint resolutions to the test and a GoldenText to snapshot.
 */
export class TestRoot {
  readonly golden: GoldenText;
  readonly logger: Logger;

  private readonly workspaceUri: vscode.Uri;
  private readonly disposables: vscode.Disposable[] = [];

  private readonly trackers = new Map<string, SessionTracker>();
  private readonly sessions: vscode.DebugSession[] = [];
  private sessionWaiter?: () => void;

  private readonly terminated = new Set<string>();
  private readonly terminationWaiters = new Map<string, (() => void)[]>();

  private readonly pauseQueue: Pause[] = [];
  private pauseWaiter?: (p: Pause) => void;

  private terminal?: vscode.Terminal;

  private constructor(testName: string, workspace: vscode.WorkspaceFolder) {
    this.workspaceUri = workspace.uri;
    this.golden = new GoldenText(testName);
    this.logger = new Logger(this.golden, new Normalizer(workspace.uri.fsPath));
  }

  /** Activate the extension, clear stale breakpoints, and arm the DAP tracker. */
  static async create(testName: string): Promise<TestRoot> {
    const ws = vscode.workspace.workspaceFolders?.[0];
    if (!ws) {
      throw new Error("no workspace folder open; runTest must launch the fixtures dir");
    }
    const ext = vscode.extensions.getExtension(EXT_ID);
    if (!ext) {
      throw new Error(`extension ${EXT_ID} not found in host`);
    }
    await ext.activate();

    const root = new TestRoot(testName, ws);
    if (vscode.debug.breakpoints.length) {
      vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
    }

    const factory = new DapTrackerFactory((session, tracker) => root.onSessionCreate(session, tracker));
    root.disposables.push(
      vscode.debug.registerDebugAdapterTrackerFactory("debugpy", factory),
      vscode.debug.onDidStartDebugSession((s) => root.onDidStart(s)),
      vscode.debug.onDidTerminateDebugSession((s) => root.onDidTerminate(s)),
    );
    return root;
  }

  /** The tracker observing `session`'s DAP traffic. */
  trackerFor(session: vscode.DebugSession): SessionTracker {
    const t = this.trackers.get(session.id);
    if (!t) {
      throw new Error(`no tracker for session ${session.id}`);
    }
    return t;
  }

  /** Absolute URI of a fixture file inside the opened workspace. */
  fixture(name: string): vscode.Uri {
    return vscode.Uri.joinPath(this.workspaceUri, name);
  }

  /** Add breakpoints through the VS Code UI model; VS Code forwards them to
   *  debugpy on session start, exactly as in production. */
  setBreakpoints(uri: vscode.Uri, specs: BpSpec[]): void {
    const bps = specs.map(
      (s) =>
        new vscode.SourceBreakpoint(
          new vscode.Location(uri, new vscode.Position(s.line - 1, 0)),
          true,
          s.condition,
          s.hitCondition,
          s.logMessage,
        ),
    );
    vscode.debug.addBreakpoints(bps);
  }

  removeBreakpoints(uri: vscode.Uri, lines: number[]): void {
    const want = new Set(lines);
    const toRemove = vscode.debug.breakpoints.filter(
      (b) =>
        b instanceof vscode.SourceBreakpoint &&
        b.location.uri.toString() === uri.toString() &&
        want.has(b.location.range.start.line + 1),
    );
    vscode.debug.removeBreakpoints(toRemove);
  }

  /** Run our command to open a Python Debug Terminal and wait for the shell. */
  async openDebugTerminal(): Promise<vscode.Terminal> {
    const opened = new Promise<vscode.Terminal>((resolve) => {
      const d = vscode.window.onDidOpenTerminal((t) => {
        d.dispose();
        resolve(t);
      });
      this.disposables.push(d);
    });
    await vscode.commands.executeCommand("vscode-py-debug.createDebugTerminal");
    const term = await withTimeout(opened, 10000, "debug terminal to open");
    this.terminal = term;
    await this.waitForShellReady(term);
    return term;
  }

  /** Launch a fixture in the terminal (uses shell integration when available so
   *  we don't race the shell prompt). */
  run(term: vscode.Terminal, script: string): void {
    const cmd = `python3 ${script}`;
    if (term.shellIntegration) {
      term.shellIntegration.executeCommand(cmd);
    } else {
      term.sendText(cmd, true);
    }
  }

  /** Resolve once `sessions[index]` has started. */
  async waitForSession(index = 0, timeoutMs = 30000): Promise<vscode.DebugSession> {
    while (this.sessions.length <= index) {
      await withTimeout(
        new Promise<void>((resolve) => {
          this.sessionWaiter = resolve;
        }),
        timeoutMs,
        `debug session #${index}`,
      );
    }
    return this.sessions[index];
  }

  get sessionCount(): number {
    return this.sessions.length;
  }

  /** Resolve on the next observed pause across all sessions (or one already
   *  queued). */
  async waitForPause(timeoutMs = 40000): Promise<Pause> {
    const queued = this.pauseQueue.shift();
    if (queued) {
      return queued;
    }
    return withTimeout(
      new Promise<Pause>((resolve) => {
        this.pauseWaiter = resolve;
      }),
      timeoutMs,
      "a stopped event",
    );
  }

  /** Resume the thread that produced `pause`. */
  async continue(pause: Pause): Promise<void> {
    await pause.session.customRequest("continue", { threadId: pause.stopped.threadId });
  }

  /** Resolve once `session` has terminated (or immediately if it already has). */
  async waitForTermination(session: vscode.DebugSession, timeoutMs = 40000): Promise<void> {
    if (this.terminated.has(session.id)) {
      return;
    }
    await withTimeout(
      new Promise<void>((resolve) => {
        const list = this.terminationWaiters.get(session.id) ?? [];
        list.push(resolve);
        this.terminationWaiters.set(session.id, list);
      }),
      timeoutMs,
      `session ${session.id} to terminate`,
    );
  }

  assertLog(): void {
    this.golden.assertLog();
  }

  /** Tear down: clear breakpoints, stop sessions, dispose terminal + listeners. */
  async dispose(): Promise<void> {
    try {
      if (vscode.debug.breakpoints.length) {
        vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
      }
    } catch {
      /* ignore */
    }
    try {
      await vscode.debug.stopDebugging();
    } catch {
      /* ignore */
    }
    try {
      this.terminal?.dispose();
    } catch {
      /* ignore */
    }
    for (const d of this.disposables) {
      try {
        d.dispose();
      } catch {
        /* ignore */
      }
    }
    // Small grace period so sessions finish tearing down before the next test
    // registers its own tracker factory.
    await delay(500);
  }

  private onSessionCreate(session: vscode.DebugSession, tracker: SessionTracker): void {
    this.trackers.set(session.id, tracker);
    tracker.onStopped = (stopped) => this.pushPause({ session, tracker, stopped });
  }

  private onDidStart(session: vscode.DebugSession): void {
    if (session.type !== "debugpy") {
      return;
    }
    this.sessions.push(session);
    const w = this.sessionWaiter;
    this.sessionWaiter = undefined;
    w?.();
  }

  private onDidTerminate(session: vscode.DebugSession): void {
    this.terminated.add(session.id);
    const waiters = this.terminationWaiters.get(session.id);
    if (waiters) {
      this.terminationWaiters.delete(session.id);
      for (const w of waiters) {
        w();
      }
    }
  }

  private pushPause(pause: Pause): void {
    const w = this.pauseWaiter;
    if (w) {
      this.pauseWaiter = undefined;
      w(pause);
    } else {
      this.pauseQueue.push(pause);
    }
  }

  /** Wait (bounded) for terminal shell integration so `run` can use
   *  executeCommand; fall back to a plain delay if it never arrives. */
  private async waitForShellReady(term: vscode.Terminal): Promise<void> {
    if (term.shellIntegration) {
      return;
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        d.dispose();
        resolve();
      }, 4000);
      const d = vscode.window.onDidChangeTerminalShellIntegration((e) => {
        if (e.terminal === term) {
          clearTimeout(timer);
          d.dispose();
          resolve();
        }
      });
    });
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
