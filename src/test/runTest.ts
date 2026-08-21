import * as path from "path";
import * as cp from "child_process";
import { pathToFileURL } from "url";
import {
  downloadAndUnzipVSCode,
  resolveCliArgsFromVSCodeExecutablePath,
  runTests,
} from "@vscode/test-electron";

async function main(): Promise<void> {
  try {
    // If we were launched from inside an Electron host (e.g. an integrated
    // terminal), ELECTRON_RUN_AS_NODE=1 leaks into our environment. Left set, it
    // makes the VS Code binary we spawn below run as a bare Node process ("bad
    // option: --extensionTestsPath" / "Cannot find module …") instead of as the
    // editor. Strip it so the test host boots as a real VS Code instance.
    delete process.env.ELECTRON_RUN_AS_NODE;

    // The folder containing package.json (extension under test).
    const extensionDevelopmentPath = path.resolve(__dirname, "../../");
    // The compiled in-host mocha entry point (out/test/suite/index.js).
    const extensionTestsPath = path.resolve(__dirname, "./suite/index");
    // The breakpoints suite drives real debug sessions whose breakpoint URIs
    // must live inside a workspace folder (so folderForCwd resolves), so we open
    // the fixtures folder as the workspace. We pass it as --folder-uri rather
    // than a bare positional path: a positional directory is intercepted by
    // Electron's default-app loader (which tries to require() it and dies with
    // "Cannot find module .../fixtures"); an --option is passed straight through
    // to VS Code. Trust is disabled (test-electron also adds this) so debugging
    // is allowed without an interactive "do you trust this folder?" prompt.
    const fixturesDir = path.resolve(extensionDevelopmentPath, "src/test/fixtures");
    const fixturesUri = pathToFileURL(fixturesDir).toString();

    const vscodeExecutablePath = await downloadAndUnzipVSCode("stable");

    // Our extension declares a hard dependency on ms-python.debugpy, so the
    // fresh test instance must have it installed or activation fails. debugpy in
    // turn depends on ms-python.python for interpreter resolution; installing it
    // explicitly is belt-and-suspenders in case dependency auto-install lags.
    const [cliPath, ...cliArgs] = resolveCliArgsFromVSCodeExecutablePath(vscodeExecutablePath);
    for (const id of ["ms-python.python", "ms-python.debugpy"]) {
      cp.spawnSync(cliPath, [...cliArgs, "--install-extension", id], {
        encoding: "utf-8",
        stdio: "inherit",
      });
    }

    await runTests({
      vscodeExecutablePath,
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: [`--folder-uri=${fixturesUri}`, "--disable-workspace-trust"],
      // Forward the golden-reset switch into the extension host so goldens can be
      // (re)generated with `RESET_GOLDEN=1 npm run test:integration`.
      extensionTestsEnv: { RESET_GOLDEN: process.env.RESET_GOLDEN },
    });
  } catch (err) {
    console.error("Integration tests failed to run:", err);
    process.exit(1);
  }
}

void main();
