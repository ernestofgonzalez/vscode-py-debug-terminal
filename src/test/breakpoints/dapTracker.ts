import * as vscode from "vscode";
import { GoldenText, Normalizer } from "./golden";

/** The DAP message shape we care about (a thin view over `any`). */
interface DapMessage {
  type: string; // "request" | "response" | "event"
  seq: number;
  event?: string;
  command?: string;
  request_seq?: number;
  arguments?: any;
  body?: any;
}

export interface Stopped {
  threadId: number;
  reason: string;
}

/** A verified/unverified breakpoint as reported in a setBreakpoints response. */
export interface ResolvedBp {
  verified: boolean;
  line?: number;
}

/**
 * Observes one debugpy session's DAP traffic and exposes only the slices the
 * breakpoint tests assert on:
 *  - `stopped` events (surfaced to the TestRoot via the `onStopped` hook),
 *  - `output` events (logpoints / stdout), captured in arrival order,
 *  - `setBreakpoints` responses, correlated back to their request's source path
 *    so a test can read "was my breakpoint verified, and on which line?".
 * One instance per debug session.
 */
export class SessionTracker {
  /** Set by the owner (TestRoot) to be notified of every `stopped` event. */
  onStopped?: (s: Stopped) => void;

  readonly outputs: string[] = [];
  private _stoppedCount = 0;

  private readonly bpBySource = new Map<string, ResolvedBp[]>();
  private readonly bpWaiters = new Map<string, ((bps: ResolvedBp[]) => void)[]>();
  /** request seq → source path, to pair a setBreakpoints response with its source. */
  private readonly pendingSetBp = new Map<number, string>();

  get stoppedCount(): number {
    return this._stoppedCount;
  }

  onWillReceive(message: DapMessage): void {
    if (message.type === "request" && message.command === "setBreakpoints") {
      const src = message.arguments?.source?.path;
      if (typeof src === "string") {
        this.pendingSetBp.set(message.seq, src);
      }
    }
  }

  onDidSend(message: DapMessage): void {
    if (message.type === "event") {
      if (message.event === "stopped") {
        this._stoppedCount++;
        const s: Stopped = {
          threadId: message.body?.threadId,
          reason: message.body?.reason,
        };
        this.onStopped?.(s);
      } else if (message.event === "output") {
        const category = message.body?.category;
        // Keep program output; drop telemetry/importer chatter.
        if (
          category === undefined ||
          category === "stdout" ||
          category === "stderr" ||
          category === "console"
        ) {
          const out = String(message.body?.output ?? "");
          if (out) {
            this.outputs.push(out);
          }
        }
      }
      return;
    }

    if (message.type === "response" && message.command === "setBreakpoints") {
      const src = message.request_seq !== undefined ? this.pendingSetBp.get(message.request_seq) : undefined;
      if (message.request_seq !== undefined) {
        this.pendingSetBp.delete(message.request_seq);
      }
      if (!src) {
        return;
      }
      const bps: ResolvedBp[] = (message.body?.breakpoints ?? []).map((b: any) => ({
        verified: !!b.verified,
        line: b.line,
      }));
      this.bpBySource.set(src, bps);
      const waiters = this.bpWaiters.get(src);
      if (waiters) {
        this.bpWaiters.delete(src);
        for (const w of waiters) {
          w(bps);
        }
      }
    }
  }

  /** Resolve with the setBreakpoints result for `sourcePath` (waiting for it if
   *  the response hasn't landed yet). */
  waitForBreakpoints(sourcePath: string, timeoutMs: number): Promise<ResolvedBp[]> {
    const have = this.bpBySource.get(sourcePath);
    if (have) {
      return Promise.resolve(have);
    }
    return withTimeout(
      new Promise<ResolvedBp[]>((resolve) => {
        const list = this.bpWaiters.get(sourcePath) ?? [];
        list.push(resolve);
        this.bpWaiters.set(sourcePath, list);
      }),
      timeoutMs,
      `setBreakpoints response for ${sourcePath}`,
    );
  }
}

/** Registered for debug type "debugpy"; makes a SessionTracker per session and
 *  hands it to the owner via `onCreate`. */
export class DapTrackerFactory implements vscode.DebugAdapterTrackerFactory {
  constructor(private readonly onCreate: (session: vscode.DebugSession, tracker: SessionTracker) => void) {}

  createDebugAdapterTracker(session: vscode.DebugSession): vscode.DebugAdapterTracker {
    const tracker = new SessionTracker();
    this.onCreate(session, tracker);
    return {
      onWillReceiveMessage: (m) => tracker.onWillReceive(m),
      onDidSendMessage: (m) => tracker.onDidSend(m),
    };
  }
}

/** A frame reduced to what a golden cares about, paths already normalized. */
export interface Frame {
  id: number;
  name: string;
  source: string;
  line: number;
}

/**
 * Curated, normalized logging on top of a GoldenText. Deliberately a small
 * vocabulary — we log breakpoint resolutions, stops, top frames, evaluated
 * values and filtered output, never raw DAP dumps. That is what keeps the
 * baselines readable and resistant to debugpy upgrades.
 */
export class Logger {
  constructor(
    private readonly golden: GoldenText,
    private readonly norm: Normalizer,
  ) {}

  line(s: string): void {
    this.golden.log(s);
  }

  /** Log the verified/line result reported for `sourcePath`, keyed by base name. */
  async logBreakpoints(
    tracker: SessionTracker,
    sourcePath: string,
    timeoutMs = 15000,
  ): Promise<ResolvedBp[]> {
    const bps = await tracker.waitForBreakpoints(sourcePath, timeoutMs);
    const name = this.norm.path(sourcePath).split("/").pop();
    for (const b of bps) {
      this.golden.log(`setBreakpoints ${name} verified=${b.verified} line=${b.line}`);
    }
    return bps;
  }

  logStopped(s: Stopped): void {
    this.golden.log(`stopped reason=${s.reason}`);
  }

  /** Fetch the stack, drop non-workspace ("internal") frames, log up to
   *  `maxFrames`, and return the surviving frames (top-first) for follow-up
   *  evaluate calls. */
  async logStackTrace(
    session: vscode.DebugSession,
    threadId: number,
    maxFrames = 3,
  ): Promise<Frame[]> {
    const frames = await this.stackFrames(session, threadId);
    frames.slice(0, maxFrames).forEach((f, i) => {
      this.golden.log(`frame#${i} ${f.name} ${f.source}:${f.line}`);
    });
    return frames;
  }

  /** The top workspace frame (throws if the pause is entirely in internals). */
  async topFrame(session: vscode.DebugSession, threadId: number): Promise<Frame> {
    const [top] = await this.stackFrames(session, threadId);
    if (!top) {
      throw new Error("no workspace stack frame at pause");
    }
    return top;
  }

  /** Evaluate `expr` in the given frame and log `expr=value`. */
  async logEvaluate(session: vscode.DebugSession, expr: string, frameId: number): Promise<string> {
    const value = await this.evaluate(session, expr, frameId);
    this.golden.log(`${expr}=${value}`);
    return value;
  }

  async evaluate(session: vscode.DebugSession, expr: string, frameId: number): Promise<string> {
    const resp = await session.customRequest("evaluate", {
      expression: expr,
      frameId,
      context: "repl",
    });
    return this.norm.scrub(String(resp?.result ?? ""));
  }

  /** Log every captured output line matching `predicate` (trailing newline
   *  trimmed), preserving arrival order. */
  logOutputs(tracker: SessionTracker, predicate: (line: string) => boolean): void {
    for (const raw of tracker.outputs) {
      const line = raw.replace(/\r?\n$/, "");
      if (predicate(line)) {
        this.golden.log(`output ${this.norm.scrub(line)}`);
      }
    }
  }

  private async stackFrames(session: vscode.DebugSession, threadId: number): Promise<Frame[]> {
    const resp = await session.customRequest("stackTrace", {
      threadId,
      startFrame: 0,
      levels: 20,
    });
    const out: Frame[] = [];
    for (const f of resp?.stackFrames ?? []) {
      const p = f.source?.path;
      if (typeof p !== "string") {
        continue;
      }
      const source = this.norm.path(p);
      if (!source.startsWith("${workspaceFolder}")) {
        continue; // drop interpreter/debugpy internals (removeNodeInternals analog)
      }
      out.push({ id: f.id, name: f.name, source, line: f.line });
    }
    return out;
  }
}

/** Reject a promise if it hasn't settled within `ms`. */
export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms waiting for ${what}`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}
