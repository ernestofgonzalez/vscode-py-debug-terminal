import { expect } from "chai";
import * as path from "path";
import * as vscode from "vscode";
import { buildTerminalEnv } from "../terminal";
import { RendezvousServer } from "../rendezvous";

const EXT_ID = "ernestofgonzalez.vscode-py-debug-terminal";

describe("buildTerminalEnv (integration)", () => {
  it("injects the injector dir on PYTHONPATH plus the IPC/token/wait flags", async () => {
    const ext = vscode.extensions.getExtension(EXT_ID);
    expect(ext, `extension ${EXT_ID} not found in host`).to.not.be.undefined;

    const extensionPath = ext!.extensionPath;
    // buildTerminalEnv only needs asAbsolutePath from the context.
    const context = {
      asAbsolutePath: (p: string) => path.join(extensionPath, p),
    } as unknown as vscode.ExtensionContext;

    const server = new RendezvousServer(() => {});
    await server.start();
    try {
      const env = buildTerminalEnv(context, server);
      const injectorDir = path.join(extensionPath, "pydebug");

      expect(env.PYTHONPATH.split(path.delimiter)[0]).to.equal(injectorDir);
      expect(env.PYDEBUG_IPC).to.equal(server.ipc);
      expect(env.PYDEBUG_TOKEN).to.equal(server.token);
      expect(env.PYDEVD_DISABLE_FILE_VALIDATION).to.equal("1");
      // waitForClient defaults to true, so the wait flag should be present.
      expect(env.PYDEBUG_WAIT).to.equal("1");
    } finally {
      server.dispose();
    }
  });
});
