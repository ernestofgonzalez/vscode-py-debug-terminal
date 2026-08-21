import { expect } from "chai";
import { TestRoot } from "./testRoot";

/**
 * End-to-end breakpoint coverage. Each test drives the real user path — set
 * breakpoints in the UI model, open a Python Debug Terminal via our command, run
 * a fixture — and snapshots a curated, normalized DAP log against a committed
 * golden (regenerate with `RESET_GOLDEN=1 npm run test:integration`).
 *
 * See PLAN.md for the scenario matrix. debugpy pin: ms-python.debugpy 2026.6.0.
 */
describe("breakpoints (e2e)", function () {
  // Real terminal + real attach + (for the child test) two sessions; be generous.
  this.timeout(90000);

  // --- Group A: core (set-before-launch + first-line) ---------------------

  it("set before launch: binds and hits inside the target function", async () => {
    const r = await TestRoot.create("set-before-launch");
    try {
      const uri = r.fixture("simple.py");
      r.setBreakpoints(uri, [{ line: 5 }]); // `result = a + b` inside add()
      const term = await r.openDebugTerminal();
      r.run(term, "simple.py");

      const pause = await r.waitForPause();
      await r.logger.logBreakpoints(pause.tracker, uri.fsPath);
      r.logger.logStopped(pause.stopped);
      await r.logger.logStackTrace(pause.session, pause.stopped.threadId);
      await r.continue(pause);

      r.assertLog();
    } finally {
      await r.dispose();
    }
  });

  it("first executable line: binds and hits (proves wait_for_client)", async () => {
    const r = await TestRoot.create("first-line");
    try {
      const uri = r.fixture("simple.py");
      r.setBreakpoints(uri, [{ line: 1 }]); // very first executed statement
      const term = await r.openDebugTerminal();
      r.run(term, "simple.py");

      const pause = await r.waitForPause();
      await r.logger.logBreakpoints(pause.tracker, uri.fsPath);
      r.logger.logStopped(pause.stopped);
      await r.logger.logStackTrace(pause.session, pause.stopped.threadId, 1);
      await r.continue(pause);

      r.assertLog();
    } finally {
      await r.dispose();
    }
  });

  it("verified line is reported back for the editor", async () => {
    const r = await TestRoot.create("verified-line");
    try {
      const uri = r.fixture("simple.py");
      r.setBreakpoints(uri, [{ line: 5 }]);
      const term = await r.openDebugTerminal();
      r.run(term, "simple.py");

      // The setBreakpoints response (verified + unchanged line) is the surface
      // VS Code shows in the editor gutter; assert it independent of the pause.
      const pause = await r.waitForPause();
      const bps = await r.logger.logBreakpoints(pause.tracker, uri.fsPath);
      expect(bps[0].verified, "breakpoint should verify").to.equal(true);
      expect(bps[0].line, "verified line should be unchanged").to.equal(5);
      await r.continue(pause);

      r.assertLog();
    } finally {
      await r.dispose();
    }
  });

  // --- Group B: multiple + conditional + hitCondition ---------------------

  it("multiple hits: pauses once per loop iteration, in order", async () => {
    const r = await TestRoot.create("multiple-hits");
    try {
      const uri = r.fixture("loop.py");
      r.setBreakpoints(uri, [{ line: 7 }]); // loop body
      const term = await r.openDebugTerminal();
      r.run(term, "loop.py");

      let pause = await r.waitForPause();
      await r.logger.logBreakpoints(pause.tracker, uri.fsPath);
      for (let n = 0; n < 5; n++) {
        if (n > 0) {
          pause = await r.waitForPause();
        }
        const top = await r.logger.topFrame(pause.session, pause.stopped.threadId);
        const i = await r.logger.evaluate(pause.session, "i", top.id);
        const total = await r.logger.evaluate(pause.session, "total", top.id);
        r.logger.line(`stop#${n} i=${i} total=${total}`);
        await r.continue(pause);
      }

      r.assertLog();
    } finally {
      await r.dispose();
    }
  });

  it("conditional: pauses only when the condition holds", async () => {
    const r = await TestRoot.create("conditional");
    try {
      const uri = r.fixture("loop.py");
      r.setBreakpoints(uri, [{ line: 7, condition: "i == 2" }]);
      const term = await r.openDebugTerminal();
      r.run(term, "loop.py");

      const pause = await r.waitForPause();
      await r.logger.logBreakpoints(pause.tracker, uri.fsPath);
      r.logger.logStopped(pause.stopped);
      const top = await r.logger.topFrame(pause.session, pause.stopped.threadId);
      await r.logger.logEvaluate(pause.session, "i", top.id);
      await r.logger.logEvaluate(pause.session, "total", top.id);
      await r.continue(pause);
      await r.waitForTermination(pause.session);
      r.logger.line(`stops=${pause.tracker.stoppedCount}`);

      r.assertLog();
    } finally {
      await r.dispose();
    }
  });

  it("hitCondition ==3: pauses on the third hit", async () => {
    const r = await TestRoot.create("hit-condition");
    try {
      const uri = r.fixture("loop.py");
      r.setBreakpoints(uri, [{ line: 7, hitCondition: "==3" }]);
      const term = await r.openDebugTerminal();
      r.run(term, "loop.py");

      const pause = await r.waitForPause();
      await r.logger.logBreakpoints(pause.tracker, uri.fsPath);
      r.logger.logStopped(pause.stopped);
      const top = await r.logger.topFrame(pause.session, pause.stopped.threadId);
      await r.logger.logEvaluate(pause.session, "i", top.id); // 0-based: 3rd hit -> i==2
      await r.logger.logEvaluate(pause.session, "total", top.id);
      await r.continue(pause);
      await r.waitForTermination(pause.session);
      r.logger.line(`stops=${pause.tracker.stoppedCount}`);

      r.assertLog();
    } finally {
      await r.dispose();
    }
  });

  // --- Group C: logpoints + remove ----------------------------------------

  it("logpoint: logs interpolated values without pausing", async () => {
    const r = await TestRoot.create("logpoint");
    try {
      const uri = r.fixture("logpoints.py");
      r.setBreakpoints(uri, [{ line: 2, logMessage: "greeting {name}" }]);
      const term = await r.openDebugTerminal();
      r.run(term, "logpoints.py");

      const session = await r.waitForSession();
      await r.waitForTermination(session); // no pause: runs to completion
      const tracker = r.trackerFor(session);
      await r.logger.logBreakpoints(tracker, uri.fsPath);
      r.logger.logOutputs(tracker, (l) => l.startsWith("greeting "));
      r.logger.line(`stops=${tracker.stoppedCount}`);
      expect(tracker.stoppedCount, "a logpoint must not pause").to.equal(0);

      r.assertLog();
    } finally {
      await r.dispose();
    }
  });

  it("removed breakpoint: does not pause", async () => {
    const r = await TestRoot.create("removed-breakpoint");
    try {
      const uri = r.fixture("loop.py");
      r.setBreakpoints(uri, [{ line: 5 }, { line: 9 }]); // both hit exactly once
      const term = await r.openDebugTerminal();
      r.run(term, "loop.py");

      const pause = await r.waitForPause(); // line 5 runs before the loop / line 9
      await r.logger.logBreakpoints(pause.tracker, uri.fsPath);
      r.logger.logStopped(pause.stopped);
      await r.logger.logStackTrace(pause.session, pause.stopped.threadId, 1);

      r.removeBreakpoints(uri, [9]); // drop the second breakpoint before continuing
      r.logger.line("removed loop.py:9");
      await r.continue(pause);
      await r.waitForTermination(pause.session);
      r.logger.line(`stops=${pause.tracker.stoppedCount}`);
      expect(pause.tracker.stoppedCount, "removed line must never pause").to.equal(1);

      r.assertLog();
    } finally {
      await r.dispose();
    }
  });

  // --- Group D: child / subprocess (env-inheritance multi-session) --------

  it("child subprocess attaches as its own session and hits its breakpoint", async () => {
    const r = await TestRoot.create("child-subprocess");
    try {
      const childUri = r.fixture("child.py");
      r.setBreakpoints(childUri, [{ line: 2 }]); // only the child has a breakpoint
      const term = await r.openDebugTerminal();
      r.run(term, "parent.py");

      // The parent has no breakpoint, so the only pause is the child's — and it
      // only exists because the child inherited PYTHONPATH + PYDEBUG_* and
      // phoned home on its own (no debugpy subprocess/fork patching).
      const pause = await r.waitForPause();
      await r.waitForSession(1);
      r.logger.line(`sessions=${r.sessionCount}`);
      await r.logger.logBreakpoints(pause.tracker, childUri.fsPath);
      r.logger.logStopped(pause.stopped);
      const frames = await r.logger.logStackTrace(pause.session, pause.stopped.threadId, 1);
      await r.logger.logEvaluate(pause.session, "x", frames[0].id);
      await r.continue(pause);

      expect(r.sessionCount, "parent + child = two debug sessions").to.equal(2);
      r.assertLog();
    } finally {
      await r.dispose();
    }
  });
});
