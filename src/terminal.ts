import * as vscode from "vscode";
import * as path from "path";
import { RendezvousServer } from "./rendezvous";

/** Must match `contributes.terminal.profiles[].id` in package.json. */
export const TERMINAL_PROFILE_ID = "vscode-py-debug.debugTerminal";
const TERMINAL_NAME = "Python Debug Terminal";

/**
 * Build the environment injected into a Python Debug Terminal. This is the whole
 * trick: put our injector directory (which contains `sitecustomize.py`) at the
 * front of PYTHONPATH so every Python process launched here runs our bootstrap
 * at startup, and hand it the rendezvous address + secret token.
 */
export function buildTerminalEnv(
  context: vscode.ExtensionContext,
  rendezvous: RendezvousServer,
): { [key: string]: string } {
  const injectorDir = context.asAbsolutePath("pydebug");
  const existingPythonPath = process.env.PYTHONPATH;
  const cfg = vscode.workspace.getConfiguration("pythonDebugTerminal");

  const env: { [key: string]: string } = {
    PYTHONPATH: existingPythonPath
      ? injectorDir + path.delimiter + existingPythonPath
      : injectorDir,
    PYDEBUG_IPC: rendezvous.ipc,
    PYDEBUG_TOKEN: rendezvous.token,
    PYDEBUG_SKIP: (cfg.get<string[]>("skipPrograms") ?? []).join(path.delimiter),
    // Silence debugpy's noisy "frozen modules" file-validation note on 3.11+.
    PYDEVD_DISABLE_FILE_VALIDATION: "1",
  };

  if (cfg.get<boolean>("waitForClient")) {
    env.PYDEBUG_WAIT = "1";
    env.PYDEBUG_WAIT_TIMEOUT = String(cfg.get<number>("waitTimeout") ?? 10);
  }
  if (cfg.get<boolean>("debugLogging")) {
    env.PYDEBUG_DEBUG = "1";
  }

  const bundled = findBundledDebugpy();
  if (bundled) {
    env.PYDEBUG_DEBUGPY_PATH = bundled;
  }

  return env;
}

export function makeTerminalProfile(
  context: vscode.ExtensionContext,
  rendezvous: RendezvousServer,
): vscode.TerminalProfile {
  return new vscode.TerminalProfile({
    name: TERMINAL_NAME,
    iconPath: new vscode.ThemeIcon("debug-alt"),
    env: buildTerminalEnv(context, rendezvous),
  });
}

export function createDebugTerminal(
  context: vscode.ExtensionContext,
  rendezvous: RendezvousServer,
): vscode.Terminal {
  const terminal = vscode.window.createTerminal({
    name: TERMINAL_NAME,
    iconPath: new vscode.ThemeIcon("debug-alt"),
    env: buildTerminalEnv(context, rendezvous),
  });
  terminal.show();
  return terminal;
}

/**
 * Best-effort: locate the debugpy that ships with the ms-python.debugpy
 * extension, so debuggees whose own environment lacks debugpy can still attach.
 * Returned as a directory to prepend/append to sys.path (the bootstrap checks it
 * exists before using it).
 */
function findBundledDebugpy(): string | undefined {
  const ext = vscode.extensions.getExtension("ms-python.debugpy");
  if (!ext) {
    return undefined;
  }
  // debugpy is vendored at <extension>/bundled/libs/debugpy.
  return path.join(ext.extensionPath, "bundled", "libs");
}
