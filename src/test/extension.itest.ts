import { expect } from "chai";
import * as vscode from "vscode";

const EXT_ID = "ernestofgonzalez.vscode-py-debug-terminal";

describe("extension activation (integration)", () => {
  it("finds, activates, and registers the create-terminal command", async () => {
    const ext = vscode.extensions.getExtension(EXT_ID);
    expect(ext, `extension ${EXT_ID} not found in host`).to.not.be.undefined;

    await ext!.activate();
    expect(ext!.isActive).to.equal(true);

    const commands = await vscode.commands.getCommands(true);
    expect(commands).to.include("vscode-py-debug-terminal.createDebugTerminal");
  });
});
