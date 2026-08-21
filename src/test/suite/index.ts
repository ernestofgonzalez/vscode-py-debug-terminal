import * as path from "path";
import * as fs from "fs";
import Mocha from "mocha";

/** Entry point invoked inside the VS Code extension host by @vscode/test-electron.
 *  Loads every compiled *.itest.js under out/test (recursively, so nested suites
 *  like out/test/breakpoints/*.itest.js are picked up too) and runs them. */
export function run(): Promise<void> {
  const mocha = new Mocha({ ui: "bdd", color: true, timeout: 20000 });

  const testsDir = path.resolve(__dirname, ".."); // out/test
  for (const file of walk(testsDir)) {
    if (file.endsWith(".itest.js")) {
      mocha.addFile(file);
    }
  }

  return new Promise((resolve, reject) => {
    try {
      mocha.run((failures) =>
        failures > 0
          ? reject(new Error(`${failures} integration test(s) failed.`))
          : resolve(),
      );
    } catch (err) {
      reject(err as Error);
    }
  });
}

/** Yield every file under `dir`, descending into subdirectories. */
function* walk(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
    } else {
      yield full;
    }
  }
}
