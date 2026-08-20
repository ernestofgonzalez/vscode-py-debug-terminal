import * as path from "path";
import * as cp from "child_process";
import {
  downloadAndUnzipVSCode,
  resolveCliArgsFromVSCodeExecutablePath,
  runTests,
} from "@vscode/test-electron";

async function main(): Promise<void> {
  try {
    // The folder containing package.json (extension under test).
    const extensionDevelopmentPath = path.resolve(__dirname, "../../");
    // The compiled in-host mocha entry point (out/test/suite/index.js).
    const extensionTestsPath = path.resolve(__dirname, "./suite/index");

    const vscodeExecutablePath = await downloadAndUnzipVSCode("stable");

    // Our extension declares a hard dependency on ms-python.debugpy, so the
    // fresh test instance must have it installed or activation fails.
    const [cliPath, ...cliArgs] = resolveCliArgsFromVSCodeExecutablePath(vscodeExecutablePath);
    cp.spawnSync(cliPath, [...cliArgs, "--install-extension", "ms-python.debugpy"], {
      encoding: "utf-8",
      stdio: "inherit",
    });

    await runTests({
      vscodeExecutablePath,
      extensionDevelopmentPath,
      extensionTestsPath,
    });
  } catch (err) {
    console.error("Integration tests failed to run:", err);
    process.exit(1);
  }
}

void main();
