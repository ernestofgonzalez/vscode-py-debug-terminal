import * as fs from "fs";
import * as path from "path";
import { expect } from "chai";

/** Where the committed `.txt` baselines live. This module runs compiled from
 *  out/test/breakpoints, so hop back to the source tree to read/write goldens
 *  that a human reviews and commits. */
const GOLDEN_DIR = path.resolve(__dirname, "../../../src/test/breakpoints");

/**
 * js-debug's `goldenText` analog: accumulate a curated, normalized log of a test
 * run, then diff it against a committed baseline. Setting `RESET_GOLDEN=1`
 * rewrites the baseline instead of asserting (see the `test:golden:reset` npm
 * script), which is the intended workflow after an intentional debugpy bump.
 */
export class GoldenText {
  private readonly lines: string[] = [];

  constructor(private readonly name: string) {}

  /** Append one already-normalized line to the log. */
  log(line: string): void {
    this.lines.push(line);
  }

  get text(): string {
    return this.lines.length ? this.lines.join("\n") + "\n" : "";
  }

  /** Compare the accumulated log to `breakpoints/<name>.txt`, or (re)write that
   *  baseline when RESET_GOLDEN=1 or no baseline exists yet. */
  assertLog(): void {
    const file = path.join(GOLDEN_DIR, `${this.name}.txt`);
    const actual = this.text;
    const reset = process.env.RESET_GOLDEN === "1";

    if (reset || !fs.existsSync(file)) {
      fs.writeFileSync(file, actual, "utf8");
      if (!reset) {
        // First-ever baseline for this test: flag it so a reviewer knows the
        // run wrote rather than checked, and eyeballs the new file.
        console.warn(`[golden] wrote new baseline ${path.basename(file)} (review before committing)`);
      }
      return;
    }

    const expected = fs.readFileSync(file, "utf8");
    expect(
      actual,
      `golden mismatch for "${this.name}" — if this change is expected, regenerate with RESET_GOLDEN=1`,
    ).to.equal(expected);
  }
}

/**
 * Turns the volatile parts of DAP payloads into stable tokens before they reach
 * a golden. Absolute paths inside the workspace become `${workspaceFolder}/…`
 * (forward-slashed); hex addresses become `<addr>`. Curated logging already
 * drops most volatility (pids, ports, seqs, thread ids), so this stays small.
 */
export class Normalizer {
  private readonly root: string;

  constructor(workspacePath: string) {
    this.root = workspacePath.replace(/\\/g, "/");
  }

  /** Absolute fs path → `${workspaceFolder}/…`, forward-slashed. Paths outside
   *  the workspace are returned forward-slashed but otherwise untouched (callers
   *  drop those as "internals"). */
  path(fsPath: string): string {
    const p = fsPath.replace(/\\/g, "/");
    return p.startsWith(this.root) ? "${workspaceFolder}" + p.slice(this.root.length) : p;
  }

  /** General scrub for free-form values (evaluate results, output text). */
  scrub(text: string): string {
    return text
      .split(this.root)
      .join("${workspaceFolder}")
      .replace(/0x[0-9a-fA-F]+/g, "<addr>");
  }
}
