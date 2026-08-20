import * as vscode from "vscode";
import { RendezvousServer, AnnouncePayload } from "./rendezvous";
import {
  TERMINAL_PROFILE_ID,
  makeTerminalProfile,
  createDebugTerminal,
} from "./terminal";
import { log } from "./log";

let rendezvous: RendezvousServer | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  rendezvous = new RendezvousServer((info) => onAnnounce(info), log);
  try {
    await rendezvous.start();
  } catch (err) {
    log(`failed to start rendezvous server: ${err}`);
    void vscode.window.showErrorMessage(
      "Python Debug Terminal: could not start its rendezvous server; auto-attach is disabled.",
    );
  }

  context.subscriptions.push(
    { dispose: () => rendezvous?.dispose() },

    vscode.window.registerTerminalProfileProvider(TERMINAL_PROFILE_ID, {
      provideTerminalProfile: () => {
        if (!rendezvous?.isRunning) {
          throw new Error("Python Debug Terminal rendezvous server is not running.");
        }
        return makeTerminalProfile(context, rendezvous);
      },
    }),

    vscode.commands.registerCommand("vscode-py-debug.createDebugTerminal", () => {
      if (!rendezvous?.isRunning) {
        void vscode.window.showErrorMessage("Python Debug Terminal is not ready yet.");
        return;
      }
      createDebugTerminal(context, rendezvous);
    }),
  );

  log("Python Debug Terminal activated");
}

export function deactivate(): void {
  rendezvous?.dispose();
  rendezvous = undefined;
}

/**
 * A debuggee phoned home. It already has debugpy listening on info.port; we ask
 * VS Code to attach to it. This is an ordinary debugpy "attach by connect"
 * session — no custom debug adapter plumbing required.
 */
async function onAnnounce(info: AnnouncePayload): Promise<void> {
  const cfg = vscode.workspace.getConfiguration("pythonDebugTerminal");
  const config: vscode.DebugConfiguration = {
    type: "debugpy",
    request: "attach",
    name: `Py: ${describe(info)}`,
    connect: { host: info.host || "127.0.0.1", port: info.port },
    justMyCode: cfg.get<boolean>("justMyCode") ?? true,
    subProcess: cfg.get<boolean>("handleForkedChildren") ?? false,
  };

  const folder = folderForCwd(info.cwd);
  const started = await vscode.debug.startDebugging(folder, config);
  if (!started) {
    log(`startDebugging returned false for pid=${info.pid}`);
  }
}

/** A short human label for the debug session, e.g. "app.py (pid 4132)". */
function describe(info: AnnouncePayload): string {
  const argv = info.argv ?? [];
  const script = argv.find((a, i) => i > 0 && !a.startsWith("-")) ?? argv[0] ?? "python";
  const base = script.split(/[\\/]/).pop() || script;
  return `${base} (pid ${info.pid})`;
}

function folderForCwd(cwd?: string): vscode.WorkspaceFolder | undefined {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders?.length) {
    return undefined;
  }
  if (cwd) {
    const match = folders.find((f) => cwd.startsWith(f.uri.fsPath));
    if (match) {
      return match;
    }
  }
  return folders[0];
}
