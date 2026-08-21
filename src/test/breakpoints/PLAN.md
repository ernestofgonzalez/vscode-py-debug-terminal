# Breakpoint E2E test plan

Status: **implemented** · Owner: _tbd_ · Created 2026-08-21 · Landed 2026-08-21

All ten scenarios (Groups A–D) pass locally on macOS against ms-python.debugpy
`2026.6.0`; goldens are committed and re-verified in a second no-reset run. Notes
on how the spike (§7.1) resolved, and env gotchas hit along the way:

- **Adapter interpreter (§7.1).** `getDebugAdapterPython()` uses the config's
  `debugAdapterPython`/`pythonPath` before falling back to the Python
  extension's *selected* interpreter (which pops a modal when none is set). Fixed
  in [extension.ts](../../extension.ts) `onAnnounce` by pinning
  `debugAdapterPython` to the debuggee's own `sys.executable` (announced in the
  rendezvous payload) — more correct *and* what makes headless attach work.
- **`ELECTRON_RUN_AS_NODE` leak.** Running the suite from inside an Electron host
  exports `ELECTRON_RUN_AS_NODE=1`, which makes the spawned VS Code binary run as
  bare Node. [runTest.ts](../runTest.ts) deletes it before spawning.
- **Workspace open.** The fixtures folder is opened via `--folder-uri`, not a
  positional path (a positional directory is intercepted by Electron's
  default-app loader).

Goal: end-to-end coverage that **breakpoints are correctly set and hit** when a
Python process is launched from a Python Debug Terminal, across the scenarios
that our extension actually influences. Modeled on
[vscode-js-debug's `src/test/breakpoints/`](https://github.com/microsoft/vscode-js-debug/tree/main/src/test/breakpoints)
suite, adapted to our architecture.

---

## 1. Why we can't just copy js-debug's harness

js-debug **owns its debug adapter**, so its tests speak DAP directly to the
adapter under test:

```ts
await p.dap.setBreakpoints({ source, breakpoints: [{ line: 3 }] });
await waitForPause(p);
p.assertLog();
```

We **don't own an adapter** — we delegate to `ms-python.debugpy`. Our extension's
job (see [extension.ts](../../extension.ts), [terminal.ts](../../terminal.ts),
[rendezvous.ts](../../rendezvous.ts) and the injected
[sitecustomize.py](../../../pydebug/sitecustomize.py)) is the pipeline that gets a
debugger attached in the first place:

```
Debug Terminal env (PYTHONPATH inject + rendezvous coords + flags)
  → debuggee sitecustomize phones home
  → RendezvousServer.onAnnounce
  → vscode.debug.startDebugging(attach-by-connect)
  → debugpy.wait_for_client() releases the process once breakpoints are configured
  → breakpoints bind & hit
```

The breakpoint *binding* is debugpy's; what we must prove is that **our pipeline
delivers the user's breakpoints to debugpy reliably**, especially the first-line
case that motivated the whole `wait_for_client` dance in
[sitecustomize.py `_wait_for_client`](../../../pydebug/sitecustomize.py). So our
tests drive the **VS Code API** (breakpoints + terminal) and **observe debugpy's
DAP traffic** through a `DebugAdapterTracker`, then snapshot a curated log.

## 2. Chosen approach

| Decision | Choice | Consequence |
| --- | --- | --- |
| Launch/observe | **Real Python Debug Terminal** — run the `createDebugTerminal` command, `sendText` the fixture, observe via a `registerDebugAdapterTrackerFactory('debugpy', …)` | Truest E2E (covers the terminal env path too); flakier — must handle shell-readiness + timing |
| Assertions | **Golden-file snapshots** — serialize a curated, normalized DAP log and diff vs a committed `.txt`, mirroring js-debug's `assertLog()` / `test:golden` | Rich sequences read well; baselines are sensitive to debugpy version + output ordering → normalization is load-bearing |
| First batch | **All four groups** (see §6): core+first-line, multiple+conditional+hitCondition, logpoints+remove, child/subprocess | Larger up-front harness investment, full coverage |

The user path we exercise: a user opens a Python Debug Terminal, sets breakpoints
in the editor, runs `python app.py`, and hits them. Breakpoints are set through
the **VS Code UI model** (`vscode.debug.addBreakpoints([new SourceBreakpoint(…)])`),
*not* by hand-sending DAP — VS Code forwards them to debugpy on session start,
exactly as in production.

## 3. Harness components to build

All new files live under [src/test/breakpoints/](.) unless noted.

1. **Suite loader recursion** — [src/test/suite/index.ts](../suite/index.ts)
   currently scans only the top of `out/test` (`fs.readdirSync(testsDir)`), so a
   nested `out/test/breakpoints/*.itest.js` would be **silently skipped**. Fix:
   walk recursively (or glob `**/*.itest.js`). _Required before any nested test
   runs._

2. **Golden text module** (`golden.ts`) — js-debug's `goldenText` analog:
   - accumulates lines via `log(value, label?)`,
   - `assertLog()` compares the accumulation to `breakpoints/<test-name>.txt`,
   - regenerates baselines when `RESET_GOLDEN=1` (write instead of compare),
   - supports `{ substring: true }` for partial matches on noisy tails.

3. **DAP observation + serialization** (`dapTracker.ts`) — a
   `DebugAdapterTrackerFactory` registered for type `debugpy` that captures, per
   session:
   - `onWillReceiveMessage` (client→adapter requests: `setBreakpoints`, `continue`, `evaluate`, …)
   - `onDidSendMessage` (adapter→client responses + events: `stopped`, `output`, `breakpoint`, `setBreakpoints` responses)

   Plus a small `Logger` with a **curated vocabulary** (not raw DAP dumps — that
   is what keeps js-debug goldens stable):
   - `logBreakpointResolution(resp)` → `verified`, normalized `line`/`source`
   - `logStopped(evt)` + `logStackTrace(threadId)` → reason + top frames (paths/lines normalized)
   - `logOutput(evt)` → logpoint / stdout lines
   - `logEvaluate(expr, frameId)` → variable value at pause (for condition/hitCondition)

4. **Test root / terminal driver** (`testRoot.ts`) — the `TestP`/`TestRoot` analog:
   - `openDebugTerminal()` → `executeCommand('vscode-py-debug.createDebugTerminal')`, capture the `Terminal` via a pre-armed `window.onDidOpenTerminal` promise,
   - `setBreakpoints(uri, specs)` → `vscode.debug.addBreakpoints`,
   - `run(script)` → `terminal.sendText('python ' + script)`,
   - `waitForSession()` → `onDidStartDebugSession` (per debuggee; child = 2nd session),
   - `waitForPause()` → resolves on the tracker's next `stopped`,
   - `continue()/stop()` → `session.customRequest('continue' | 'disconnect', …)`,
   - `dispose()` → remove breakpoints, `stopDebugging()`, dispose terminal, best-effort kill.

5. **Fixtures + test workspace** — Python scripts under
   [src/test/fixtures/](../fixtures/) (not compiled; referenced by absolute path):
   | fixture | purpose |
   | --- | --- |
   | `simple.py` | one function + a couple of statements → set-before-launch, first-line |
   | `loop.py` | `for i in range(5): total = add(total, i)` → multiple hits, conditional (`i==2`), hitCondition (`==3`) |
   | `logpoints.py` | a few lines to attach `logMessage` to |
   | `parent.py` + `child.py` | `parent.py` does `subprocess.run([sys.executable, child.py])`; **`child.py` is a real file** (not `-c`) so we can set a file breakpoint in it |

   `runTest.ts` must open this folder as the workspace:
   `runTests({ …, launchArgs: [fixturesDir, '--disable-workspace-trust'] })`, so
   breakpoint URIs resolve inside a workspace folder and
   [`folderForCwd`](../../extension.ts) finds one.

6. **Reset-golden workflow** — npm script
   `"test:golden:reset": "RESET_GOLDEN=1 npm run test:integration"` and a README note.

## 4. Normalization rules (the crux of golden stability)

Raw DAP is nondeterministic. Before a value is logged, replace every volatile
field with a stable token, or drop it:

| Volatile | Rule |
| --- | --- |
| Absolute paths | `${workspaceFolder}/…`, forward-slashed |
| pids / ppids | `<pid>` (or index: `pid#0`, `pid#1` for parent/child) |
| ports (listen + rendezvous) | `<port>` |
| `threadId`, `seq`, `sessionId`, `variablesReference`, frame `id` | `<id>` (or stable per-test counter) |
| debugpy / adapter version banners, `debugpyWaitingForServer` chatter | drop |
| stdout ordering vs `output` events | log `output` events **sorted** or filtered to the fixture's own prints |
| memory addresses `0x…`, timestamps | `<addr>` / drop |
| node/py internal stack frames | drop, like js-debug's `removeNodeInternalsStackLines` |

Pin the observed surface to a **small allow-list of DAP messages** per test
rather than "everything the adapter emitted" — this is what makes the diff
reviewable and resistant to debugpy upgrades. When debugpy is intentionally
upgraded, regenerate with `RESET_GOLDEN=1` and eyeball the diff.

## 5. Per-test skeleton

```ts
// src/test/breakpoints/breakpoints.itest.ts  (runs in the extension host)
describe("breakpoints (e2e)", () => {
  it("set before launch: binds and hits on the target line", async () => {
    const r = await TestRoot.create();               // activates ext, arms tracker
    try {
      const uri = r.fixture("simple.py");
      await r.setBreakpoints(uri, [{ line: 12 }]);    // VS Code UI model
      const term = await r.openDebugTerminal();       // real terminal
      r.run(term, "simple.py");                       // sendText python simple.py
      await r.waitForSession();                       // onDidStartDebugSession
      const stop = await r.waitForPause();            // tracker 'stopped'
      await r.logger.logBreakpointResolution();       // verified + line
      await r.logger.logStackTrace(stop.threadId);    // normalized top frame
      await r.continue(stop.threadId);                // run to completion
      r.assertLog();                                  // vs breakpoints/set-before-launch.txt
    } finally {
      await r.dispose();
    }
  });
});
```

Generous timeouts: the in-host mocha timeout is 20s
([suite/index.ts](../suite/index.ts)); bump the breakpoints suite to ~40s to
absorb VS Code download-warmup, shell init, and `wait_for_client`.

## 6. Scenario matrix (first batch)

Each row → one golden test. "js-debug analog" points at the file we mirrored.

### Group A — Core: set-before-launch + first-line
| Test | Fixture | Breakpoint | Assert (golden) | js-debug analog |
| --- | --- | --- | --- | --- |
| set before launch binds & hits | `simple.py` | line inside `add` | `verified:true`, pause at that line, top frame | `configure > script` |
| first executable line binds & hits | `simple.py` | line 1 / first real statement | pause on first line (proves `wait_for_client`) | `first line > breaks if requested` |
| verified line reported back to editor | `simple.py` | valid line | `setBreakpoints` response `verified:true`, unchanged `line` | verified assertions in `launched > source map` |

### Group B — Multiple + conditional + hitCondition
| Test | Fixture | Breakpoint | Assert | js-debug analog |
| --- | --- | --- | --- | --- |
| multiple hits in order | `loop.py` | line in loop body | N pauses; log `i`/`total` each pause | hit ordering across suite |
| conditional pauses only when true | `loop.py` | loop body, `condition:"i==2"` | single pause; `i==2` | `condition > basic` |
| hitCondition == N | `loop.py` | loop body, `hitCondition:"==3"` | pauses on 3rd hit; `i==2` (0-based) | `hit condition > exact` |

### Group C — Logpoints + remove
| Test | Fixture | Breakpoint | Assert | js-debug analog |
| --- | --- | --- | --- | --- |
| logpoint logs without pausing | `logpoints.py` | line, `logMessage:"i={i}"` | `output` events with interpolated values; **no** `stopped` | `logpoints > basic` |
| removed breakpoint does not pause | `loop.py` | set two, pause at first, **remove** second, continue | only expected pauses; removed line never hit | `configure/launched > remove` |

### Group D — Child / subprocess (our differentiator)
| Test | Fixture | Breakpoint | Assert | js-debug analog |
| --- | --- | --- | --- | --- |
| child subprocess attaches as its own session and hits its breakpoint | `parent.py` + `child.py` | bp in `child.py` | **two** `onDidStartDebugSession`; child pauses at its bp | _none — validates env-inheritance multi-session design_ |

Note: the child attaches purely via **environment inheritance** (PYTHONPATH +
`PYDEBUG_*` inherited → child runs `sitecustomize` → phones home → 2nd session).
This needs **no** `handleForkedChildren`/`subProcess` flag (that flag is debugpy's
fork patching, a separate concern). Call that distinction out in the test name.

## 7. Prerequisites / risks / open questions

1. **Adapter interpreter (spike first).** `startDebugging` with
   `type:debugpy, request:attach, connect:{…}` still needs a Python interpreter to
   run the debugpy *adapter*. In a bare headless host with no selected
   interpreter this may fail. Spike: confirm attach works; if not, set
   `python.defaultInterpreterPath` (test settings) or add `python` to the
   [onAnnounce](../../extension.ts) config. **This gates the whole suite** — do it
   before building fixtures.
2. **debuggee debugpy resolution.** System `python3` here has no importable
   `debugpy`; the debuggee falls back to `PYDEBUG_DEBUGPY_PATH` = ms-python.debugpy's
   `bundled/libs` (installed by [runTest.ts](../runTest.ts)). Good — but the test
   asserts this fallback path works E2E, so keep ms-python.debugpy install in
   runTest.
3. **Flakiness (real terminal + golden = worst case).** Mitigations: use the
   rendezvous announce / `onDidStartDebugSession` as the readiness signal (not a
   fixed sleep); normalize aggressively (§4); allow-list DAP messages; retry the
   whole suite once in CI if needed.
4. **Golden churn on debugpy upgrades.** ms-python.debugpy is `2026.6.0` in the
   test host today. Note the pinned version next to the goldens; regenerate with
   `RESET_GOLDEN=1` on intentional bumps.
5. **Workspace-trust / folder.** Must launch with the fixtures folder + trust
   disabled, else breakpoints/`folderForCwd` misbehave (§3.5).
6. **Windows** is out of scope for this batch (CI is ubuntu + macOS only).

## 8. Order of work

1. Spike §7.1 (adapter interpreter) — de-risk attach headless.
2. Suite loader recursion (§3.1) + `runTest` `launchArgs` (§3.5).
3. Golden module (§3.2) + `RESET_GOLDEN` + npm script.
4. DAP tracker + Logger + normalization (§3.3, §4).
5. TestRoot/terminal driver (§3.4) + fixtures (§3.5).
6. Group A tests → generate + hand-review goldens.
7. Groups B, C, D.
8. Update [README.md](../../../README.md) test section + note the debugpy pin.

## 9. Explicitly out of scope (and why)

These are debugpy/language-adapter features we don't own; testing them tests
debugpy, not our extension:

- source maps / path-mapped / absolute-root sources (js-debug `configure > source map*`)
- hot-transpiled / TS / babel breakpoint placement (js-debug `hot-transpiled`, `breakpoint placement`)
- custom instrumentation breakpoints, `stepInTargets`, `excludeCallers`, async stacks (js-debug `custom`, `stepInTargets`, …)
- restart-frame, source query strings, webpack nul-byte, vue

Sibling suite (not here): **negative-attach** tests — `skipPrograms`, `python -S/-E/-I`
produce **no** debug session — belong in a `attach.itest.ts`, since they assert
absence of a session rather than breakpoint behavior.

## 10. Definition of done

- [x] Spike confirms headless attach; interpreter handling decided (`debugAdapterPython` = debuggee interpreter).
- [x] Suite loader finds nested `*.itest.js`; `runTest` opens fixtures workspace.
- [x] Golden harness + `RESET_GOLDEN` + `test:golden:reset` script.
- [x] DAP tracker + normalized Logger.
- [x] Fixtures committed.
- [x] All Group A–D tests pass locally (macOS), goldens hand-reviewed. _(CI ubuntu+macOS: pending a CI run.)_
- [x] README updated; debugpy version pinned/noted.
