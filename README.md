# Python Debug Terminal

A **Python Debug Terminal** for VS Code: open one, and every Python process you
launch from it attaches to the debugger automatically — including child
processes it spawns. This is the Python analogue of the built-in **JavaScript
Debug Terminal**.

```
┌──────────────────────┐        announces {pid, port, token}        ┌────────────────────┐
│  Python Debug Term.   │  ── sitecustomize phones home over TCP ──▶ │  Extension (rendez- │
│  (PYTHONPATH injected) │                                            │  vous TCP server)   │
│                        │                                            │                     │
│  $ python app.py       │  ◀── VS Code attaches (debugpy connect) ── │  startDebugging()   │
└──────────────────────┘                                            └────────────────────┘
```

## How it works

The design mirrors the JavaScript Debug Terminal, with Python-appropriate
substitutes for each moving part:

| Concern | JavaScript Debug Terminal | Python Debug Terminal |
| --- | --- | --- |
| Injection | `NODE_OPTIONS=--require bootloader.js` | `sitecustomize.py` on `PYTHONPATH` |
| Bootstrap | bootloader enables inspector, dials pipe | `sitecustomize` opens `debugpy.listen()`, dials TCP |
| Rendezvous | IPC pipe owned by the extension | localhost TCP server owned by the extension |
| One session / process | phones home per process | announces per process |
| Children | env inheritance | env inheritance |

1. **Injection.** When the terminal opens, the extension prepends
   [`pydebug/`](pydebug/) to `PYTHONPATH` and sets `PYDEBUG_IPC` (the rendezvous
   address) and `PYDEBUG_TOKEN` (a per-session secret). See
   [`src/terminal.ts`](src/terminal.ts).
2. **Bootstrap.** [`pydebug/sitecustomize.py`](pydebug/sitecustomize.py) is
   imported by CPython's `site` machinery at startup. It filters out tooling
   noise, opens a `debugpy` listener on an ephemeral port, and announces
   `{pid, port, token, …}` to the rendezvous server.
3. **Attach.** The extension validates the token and calls
   `vscode.debug.startDebugging` with an ordinary debugpy *attach-by-connect*
   config pointed at the announced port. See [`src/extension.ts`](src/extension.ts).
4. **Children come free.** Environment variables inherit, so
   `subprocess.Popen([sys.executable, "worker.py"])` re-runs `sitecustomize` and
   the worker attaches as its own session.

### Why `sitecustomize`, not a `.pth` file

The obvious design — ship a `.pth` file whose `import` line runs the bootstrap —
**does not work via `PYTHONPATH`.** CPython only executes `.pth` files found in
*site* directories (site-packages), not arbitrary `PYTHONPATH` entries. A
`sitecustomize` module, by contrast, is imported automatically as long as it is
importable, which `PYTHONPATH` guarantees. This was verified empirically before
choosing the mechanism.

Because we may shadow a user's own `sitecustomize`, our bootstrap removes its own
directory from `sys.path` and then chains to any real `sitecustomize` it hid.

### Why attach-by-connect, not a custom adapter

The debuggee could instead `debugpy.connect()` back to an extension-owned socket
that we adopt as the debug adapter transport (via a
`DebugAdapterDescriptorFactory`). That is the more faithful mirror of the JS
bootloader, but the socket-adoption factory is the one genuinely fragile piece.
This scaffold takes the robust path: the debuggee **listens**, announces its
port, and the extension attaches with a stock config. No custom adapter plumbing.

## Known blind spots (by design)

- `python -S`, `-E`, `-I` skip site processing / ignore `PYTHONPATH` → no attach.
- `os.fork()` / `multiprocessing` (default `fork` on Linux) children never re-run
  interpreter startup, so `sitecustomize` never fires. Enable
  `pythonDebugTerminal.handleForkedChildren` to let debugpy patch `fork`/`spawn`
  instead.
- Anything that scrubs its environment before spawning breaks the inheritance
  chain (same as `NODE_OPTIONS` in Node).
- A shell rc file that unconditionally `export PYTHONPATH=...` can clobber our
  prepend.
- The debuggee needs `debugpy` importable. If it isn't, the extension points
  `PYDEBUG_DEBUGPY_PATH` at the copy bundled with `ms-python.debugpy` as a
  best-effort fallback.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `pythonDebugTerminal.waitForClient` | `true` | Pause each process at startup until the debugger attaches and sends breakpoints (required for breakpoints to reliably bind). |
| `pythonDebugTerminal.waitTimeout` | `10` | Max seconds to wait when the above is on. |
| `pythonDebugTerminal.skipPrograms` | pip, black, ruff, mypy, … | Program names never attached to. |
| `pythonDebugTerminal.justMyCode` | `true` | Passed through to debugpy. |
| `pythonDebugTerminal.handleForkedChildren` | `false` | Debug `fork`/`multiprocessing` children via debugpy's patching. |
| `pythonDebugTerminal.debugLogging` | `false` | Verbose bootstrap diagnostics on stderr. |

## Develop

```bash
npm install
npm run compile      # or: npm run watch
```

Then press <kbd>F5</kbd> ("Run Extension"). In the Extension Development Host,
open the terminal dropdown → **Python Debug Terminal** (or run the
**Create Python Debug Terminal** command), then `python your_script.py`.

Requires the `ms-python.debugpy` extension (declared as an extension dependency),
which provides the `debugpy` debug type used to attach.

## Tests

The setup follows [vscode-js-debug](https://github.com/microsoft/vscode-js-debug):
`mocha` + `chai` + `sinon` run under [`tsx`](https://github.com/privatenumber/tsx)
via [`.mocharc.unit.js`](.mocharc.unit.js), with `*.test.ts` specs colocated next
to their sources. The Python bootstrap is covered by a stdlib `unittest` suite.

```bash
npm test              # fast suite: types + unit (TS) + python
npm run test:types    # tsc --noEmit
npm run test:unit     # mocha specs: src/**/*.test.ts (run under tsx)
npm run test:py       # python3 -m unittest discover -s pydebug -p 'test_*.py'
npm run test:integration  # launches a real VS Code instance (see below)
```

### Unit tests (fast, no VS Code)

- [`src/rendezvous.test.ts`](src/rendezvous.test.ts) — the rendezvous wire
  protocol: token accept/reject, malformed/oversized/portless payloads, dispose,
  and logger notifications. `RendezvousServer` takes an injected logger (rather
  than importing the `vscode`-backed one) specifically so it unit-tests in plain
  Node — the same decoupling js-debug relies on.
- [`pydebug/test_sitecustomize.py`](pydebug/test_sitecustomize.py) — the
  attach/skip filtering (debugpy/pydevd self-skip, skip-list by basename and by
  path component, IPC gating) and `sys.path` hygiene. The bootstrap honors
  `PYDEBUG_DISABLE_AUTOINSTALL=1` so it can be imported without attaching.

### Integration tests (real extension host)

Mirroring js-debug's `test:golden`/`runTest.js` layer,
[`src/test/runTest.ts`](src/test/runTest.ts) uses `@vscode/test-electron` to
download a real VS Code, install the `ms-python.debugpy` dependency, and run
`*.itest.ts` specs inside the extension host:

- [`src/test/extension.itest.ts`](src/test/extension.itest.ts) — the extension
  activates and registers its command.
- [`src/test/terminal.itest.ts`](src/test/terminal.itest.ts) — `buildTerminalEnv`
  injects the injector dir on `PYTHONPATH` plus the IPC/token/wait flags.

These compile to `out/` via [`tsconfig.integration.json`](tsconfig.integration.json)
(kept separate from the esbuild bundle and the tsx unit run). The run launches a
GUI process, so it needs a display: it works locally and on CI (macOS runners, or
Linux under `xvfb-run`). [`.github/workflows/ci.yml`](.github/workflows/ci.yml)
runs the fast suite plus the integration tests on Ubuntu and macOS.

### Coverage

Coverage uses [`nyc`](https://github.com/istanbuljs/nyc) (Istanbul) for the
TypeScript side, as in js-debug, and [`coverage.py`](https://coverage.readthedocs.io/)
for the Python bootstrap:

```bash
npm run coverage      # nyc over the tsx unit run -> text + coverage/ (html, lcov.info)
npm run coverage:py   # coverage.py over the bootstrap tests (needs: pip install coverage)
```

`nyc` maps back to the original `.ts` via tsx's source maps
([`.nycrc.json`](.nycrc.json)); `coverage.py` is configured by
[`.coveragerc`](.coveragerc). Both measure the **unit-tested** code paths, so the
numbers reflect the pure logic (the rendezvous protocol and the bootstrap's
attach/skip filtering) — not the debugpy/GUI paths, which are exercised by the
integration layer instead. CI runs both on every push.

## Status

This is a scaffold: the full injection → rendezvous → attach path is implemented
and the Python/`PYTHONPATH` contracts are verified, but it has not been hardened
for remote/SSH/container path mapping, Windows quoting edge cases, or a published
Marketplace release.
