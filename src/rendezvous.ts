import * as net from "net";
import * as crypto from "crypto";

/** The announcement a debuggee's bootstrap sends when it decides to attach. */
export interface AnnouncePayload {
  v: number;
  token: string;
  pid: number;
  ppid?: number;
  argv: string[];
  python?: string;
  cwd?: string;
  /** Host/port the debuggee's debugpy is now listening on for the adapter. */
  host: string;
  port: number;
}

export type AnnounceHandler = (info: AnnouncePayload) => void | Promise<void>;

/** A logging sink. Injected so this module stays free of any `vscode` import
 *  and can be unit-tested in plain Node. Defaults to a no-op. */
export type Logger = (message: string) => void;

/**
 * A tiny localhost TCP server that debuggee bootstraps "phone home" to. This is
 * the extension-side rendezvous point: when a process announces itself (with a
 * matching secret token), we hand it off to `onAnnounce`, which turns it into a
 * VS Code debug session.
 *
 * Wire protocol: the client sends a single line of JSON (an AnnouncePayload)
 * terminated by "\n"; the server replies with one line of JSON `{ok, msg}` and
 * closes. One connection == one process announcement.
 */
export class RendezvousServer {
  private server?: net.Server;
  readonly token: string;
  private readonly _host = "127.0.0.1";
  private _port = 0;

  constructor(
    private readonly onAnnounce: AnnounceHandler,
    private readonly log: Logger = () => {},
  ) {
    // Secret so an unrelated local process can't inject debug sessions into us.
    this.token = crypto.randomBytes(24).toString("hex");
  }

  get host(): string {
    return this._host;
  }
  get port(): number {
    return this._port;
  }
  get ipc(): string {
    return `${this._host}:${this._port}`;
  }
  get isRunning(): boolean {
    return !!this.server;
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = net.createServer((socket) => this.handleConnection(socket));
      server.once("error", (err) => {
        this.log(`rendezvous server error: ${err}`);
        reject(err);
      });
      server.listen(0, this._host, () => {
        const addr = server.address();
        if (addr && typeof addr === "object") {
          this._port = addr.port;
        }
        this.server = server;
        this.log(`rendezvous listening on ${this.ipc}`);
        resolve();
      });
    });
  }

  private handleConnection(socket: net.Socket): void {
    socket.setEncoding("utf8");
    socket.setTimeout(5000, () => socket.destroy());

    let buf = "";
    const reply = (ok: boolean, msg?: string) => {
      try {
        socket.write(JSON.stringify({ ok, msg }) + "\n");
      } catch {
        /* ignore */
      }
      socket.end();
    };

    socket.on("data", (chunk: string) => {
      buf += chunk;
      const nl = buf.indexOf("\n");
      if (nl < 0) {
        if (buf.length > 64 * 1024) {
          reply(false, "payload too large");
        }
        return;
      }

      const line = buf.slice(0, nl);
      let payload: AnnouncePayload;
      try {
        payload = JSON.parse(line) as AnnouncePayload;
      } catch {
        reply(false, "bad json");
        return;
      }

      if (!payload || typeof payload.token !== "string" || !this.tokenMatches(payload.token)) {
        this.log("rejected announcement: bad or missing token");
        reply(false, "unauthorized");
        return;
      }
      if (typeof payload.port !== "number" || !payload.port) {
        reply(false, "missing debug port");
        return;
      }

      this.log(
        `announce pid=${payload.pid} debugPort=${payload.port} argv=${JSON.stringify(
          (payload.argv ?? []).slice(0, 3),
        )}`,
      );
      Promise.resolve(this.onAnnounce(payload)).catch((e) => this.log(`onAnnounce error: ${e}`));
      reply(true);
    });

    socket.on("error", () => {
      /* client vanished; nothing to do */
    });
  }

  private tokenMatches(candidate: string): boolean {
    const a = Buffer.from(candidate);
    const b = Buffer.from(this.token);
    if (a.length !== b.length) {
      return false;
    }
    return crypto.timingSafeEqual(a, b);
  }

  dispose(): void {
    this.server?.close();
    this.server = undefined;
    this.log("rendezvous server disposed");
  }
}
