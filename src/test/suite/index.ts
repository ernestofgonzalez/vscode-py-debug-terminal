import * as path from "path";
import * as fs from "fs";
import Mocha from "mocha";

/** Entry point invoked inside the VS Code extension host by @vscode/test-electron.
 *  Loads every compiled *.itest.js sitting in out/test and runs them with mocha. */
export function run(): Promise<void> {
  const mocha = new Mocha({ ui: "bdd", color: true, timeout: 20000 });

  const testsDir = path.resolve(__dirname, ".."); // out/test
  for (const file of fs.readdirSync(testsDir)) {
    if (file.endsWith(".itest.js")) {
      mocha.addFile(path.join(testsDir, file));
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
