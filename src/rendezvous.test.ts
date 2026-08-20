import { expect } from "chai";
import * as net from "net";
import * as sinon from "sinon";
import { AnnouncePayload, RendezvousServer } from "./rendezvous";

/** Open a connection, write `raw`, resolve with the first line of the reply. */
function request(port: number, raw: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    let buf = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(raw));
    socket.on("data", (d: string) => {
      buf += d;
      if (buf.includes("\n")) {
        resolve(buf.slice(0, buf.indexOf("\n")));
        socket.end();
      }
    });
    socket.on("error", reject);
    socket.setTimeout(3000, () => {
      socket.destroy();
      reject(new Error("request timed out"));
    });
  });
}

const announce = (port: number, obj: unknown) =>
  request(port, JSON.stringify(obj) + "\n");

function validPayload(token: string, overrides: Partial<AnnouncePayload> = {}): AnnouncePayload {
  return {
    v: 1,
    token,
    pid: 1234,
    ppid: 1,
    argv: ["/home/me/app.py"],
    python: "/usr/bin/python3",
    cwd: "/home/me",
    host: "127.0.0.1",
    port: 55555,
    ...overrides,
  };
}

async function assertRejects(p: Promise<unknown>): Promise<void> {
  try {
    await p;
  } catch {
    return;
  }
  throw new Error("expected the promise to reject");
}

describe("RendezvousServer", () => {
  let received: AnnouncePayload[];
  let server: RendezvousServer;

  beforeEach(async () => {
    received = [];
    server = new RendezvousServer((info) => {
      received.push(info);
    });
    await server.start();
  });

  afterEach(() => {
    server.dispose();
  });

  it("binds a port and exposes a non-empty token and ipc address", () => {
    expect(server.isRunning).to.equal(true);
    expect(server.port).to.be.greaterThan(0);
    expect(server.token).to.have.length.greaterThan(0);
    expect(server.ipc).to.equal(`127.0.0.1:${server.port}`);
  });

  it("generates a distinct token per instance", () => {
    const other = new RendezvousServer(() => {});
    expect(other.token).to.not.equal(server.token);
  });

  it("accepts a valid announcement carrying the correct token", async () => {
    const reply = JSON.parse(await announce(server.port, validPayload(server.token)));
    expect(reply.ok).to.equal(true);
    expect(received).to.have.length(1);
    expect(received[0].pid).to.equal(1234);
    expect(received[0].port).to.equal(55555);
  });

  it("rejects an announcement with a wrong token and does not hand it off", async () => {
    const reply = JSON.parse(await announce(server.port, validPayload("not-the-token")));
    expect(reply.ok).to.equal(false);
    expect(reply.msg).to.equal("unauthorized");
    expect(received).to.have.length(0);
  });

  it("rejects a payload missing the debug port", async () => {
    const payload = validPayload(server.token);
    delete (payload as Partial<AnnouncePayload>).port;
    const reply = JSON.parse(await announce(server.port, payload));
    expect(reply.ok).to.equal(false);
    expect(reply.msg).to.equal("missing debug port");
    expect(received).to.have.length(0);
  });

  it("rejects malformed JSON", async () => {
    const reply = JSON.parse(await request(server.port, "definitely not json\n"));
    expect(reply.ok).to.equal(false);
    expect(reply.msg).to.equal("bad json");
    expect(received).to.have.length(0);
  });

  it("rejects an oversized line that never terminates", async () => {
    const reply = JSON.parse(await request(server.port, "x".repeat(70 * 1024)));
    expect(reply.ok).to.equal(false);
    expect(reply.msg).to.equal("payload too large");
    expect(received).to.have.length(0);
  });

  it("refuses new connections after dispose()", async () => {
    const port = server.port;
    server.dispose();
    expect(server.isRunning).to.equal(false);
    await new Promise((r) => setTimeout(r, 50));
    await assertRejects(request(port, "{}\n"));
  });

  it("reports lifecycle and rejection events to the injected logger", async () => {
    const logger = sinon.spy();
    const s = new RendezvousServer(() => {}, logger);
    await s.start();
    try {
      await announce(s.port, validPayload("wrong"));
      const messages = logger.getCalls().map((c) => String(c.args[0]));
      expect(messages.some((m) => m.includes("rendezvous listening"))).to.equal(true);
      expect(messages.some((m) => m.includes("bad or missing token"))).to.equal(true);
    } finally {
      s.dispose();
    }
  });
});
