"""Python Debug Terminal -- in-process bootstrap.

This module is injected into every Python process launched from a "Python Debug
Terminal" by putting its directory at the front of PYTHONPATH. CPython's ``site``
machinery imports a module named ``sitecustomize`` at startup if one is
importable -- that's us. We decide whether this process should be debugged and,
if so, open a debugpy listener and phone home to the extension so it can attach.

Design notes
------------
* Injection is via ``sitecustomize`` on PYTHONPATH -- NOT a ``.pth`` file.
  CPython only executes ``.pth`` files found in *site* directories, so the
  "``.pth`` on PYTHONPATH" trick never fires. ``sitecustomize`` does.
* ``python -S`` / ``-E`` / ``-I`` skip site processing or ignore PYTHONPATH, so
  those invocations silently won't attach. This mirrors the JavaScript Debug
  Terminal's blind spot when NODE_OPTIONS is disabled.
* We must NEVER crash or noticeably slow the host process. Everything is wrapped
  so failures degrade to "no debugger", never to a traceback in the user's
  program.
* We attach by having the debuggee ``debugpy.listen()`` on an ephemeral port and
  announcing that port to the extension, which then attaches with an ordinary
  debugpy "attach by connect" session. No custom debug adapter is required.
"""

import os
import sys


def _debug_enabled():
    return os.environ.get("PYDEBUG_DEBUG") == "1"


def _log(msg):
    if _debug_enabled():
        try:
            sys.stderr.write("[pydebug] " + msg + "\n")
        except Exception:
            pass


def _norm(p):
    try:
        return os.path.normcase(os.path.abspath(p))
    except Exception:
        return p


def _remove_self_from_syspath():
    """Drop our injector directory from sys.path so we never shadow the user's
    own modules after we've been imported."""
    here = _norm(os.path.dirname(os.path.abspath(__file__)))
    sys.path[:] = [p for p in sys.path if _norm(p) != here]


def _chain_to_user_sitecustomize():
    """If the user had their own sitecustomize that we shadowed by being first on
    PYTHONPATH, run it now that our directory is off sys.path."""
    sys.modules.pop("sitecustomize", None)
    try:
        import sitecustomize  # noqa: F401  (the user's real one, if any)
    except ImportError:
        pass
    except Exception as exc:  # the user's sitecustomize is their concern, not ours
        _log("user sitecustomize raised: %r" % (exc,))


def _should_attach():
    if not os.environ.get("PYDEBUG_IPC"):
        _log("no PYDEBUG_IPC; skipping")
        return False

    argv = list(sys.argv) if sys.argv else [""]
    joined = " ".join(argv)

    # Never attach to the debug machinery itself. The debugpy adapter subprocess
    # and pydevd inherit our PYTHONPATH too, and attaching to them would recurse.
    if "debugpy" in joined or "pydevd" in joined:
        _log("debugpy/pydevd process; skipping")
        return False

    argv0 = (argv[0] or "").replace("\\", "/")
    prog = os.path.basename(argv0.rstrip("/"))
    skip = set(filter(None, os.environ.get("PYDEBUG_SKIP", "").split(os.pathsep)))
    # Match the executable basename and any path component, so that both
    # `ruff ...` and `python -m pip ...` (argv0 == .../pip/__main__.py) are caught.
    parts = set(filter(None, argv0.split("/")))
    if prog in skip or (skip & parts):
        _log("skip-listed program %r; skipping" % (prog,))
        return False

    return True


def _resolve_debugpy():
    try:
        import debugpy

        return debugpy
    except ImportError:
        pass

    extra = os.environ.get("PYDEBUG_DEBUGPY_PATH")
    if extra and os.path.isdir(extra):
        sys.path.append(extra)
        try:
            import debugpy

            return debugpy
        except ImportError:
            _log("debugpy not importable even via PYDEBUG_DEBUGPY_PATH")
    else:
        _log("debugpy not installed and no bundled fallback available")
    return None


def _announce(server_host, server_port, listen_host, listen_port):
    import json
    import socket

    info = {
        "v": 1,
        "token": os.environ.get("PYDEBUG_TOKEN", ""),
        "pid": os.getpid(),
        "ppid": os.getppid(),
        "argv": list(sys.argv),
        "python": sys.executable,
        "cwd": os.getcwd(),
        "host": listen_host,
        "port": listen_port,
    }
    try:
        conn = socket.create_connection((server_host, server_port), timeout=2.0)
    except OSError as exc:
        _log("discovery server unreachable (%r); running without debugger" % (exc,))
        return False
    try:
        conn.sendall((json.dumps(info) + "\n").encode("utf-8"))
        conn.settimeout(2.0)
        try:
            conn.recv(256)  # best-effort ack; we don't require it
        except OSError:
            pass
    finally:
        try:
            conn.close()
        except OSError:
            pass
    return True


def _wait_for_client(debugpy):
    """Block until the IDE has attached AND finished configuring the session
    (i.e. sent its breakpoints), so breakpoints on the very first lines bind.

    We use debugpy.wait_for_client(), which is the correct primitive for this --
    unlike polling is_client_connected(), it returns only after the initial DAP
    handshake completes, not merely when the socket connects. It has no timeout
    of its own, so we run it in a daemon thread and bound the wait: if the attach
    never completes (e.g. the extension failed to start the session), we proceed
    unattached rather than hanging the user's process forever."""
    import threading

    try:
        timeout = float(os.environ.get("PYDEBUG_WAIT_TIMEOUT", "10"))
    except ValueError:
        timeout = 10.0

    done = threading.Event()

    def _wait():
        try:
            debugpy.wait_for_client()
        except Exception as exc:
            _log("wait_for_client raised: %r" % (exc,))
        finally:
            done.set()

    threading.Thread(target=_wait, name="pydebug-wait", daemon=True).start()
    if done.wait(timeout):
        _log("debugger attached")
    else:
        _log("timed out waiting for debugger; continuing")


def _attach():
    ipc = os.environ.get("PYDEBUG_IPC", "")
    server_host, sep, port_str = ipc.rpartition(":")
    if not sep:
        _log("malformed PYDEBUG_IPC %r" % (ipc,))
        return
    server_host = server_host or "127.0.0.1"
    try:
        server_port = int(port_str)
    except ValueError:
        _log("malformed discovery port %r" % (port_str,))
        return

    debugpy = _resolve_debugpy()
    if debugpy is None:
        return

    try:
        listen_host, listen_port = debugpy.listen(("127.0.0.1", 0))
    except Exception as exc:
        _log("debugpy.listen failed: %r" % (exc,))
        return

    if not _announce(server_host, server_port, listen_host, listen_port):
        return

    if os.environ.get("PYDEBUG_WAIT") == "1":
        _wait_for_client(debugpy)


def install():
    """Entry point, run once by ``site`` at interpreter startup."""
    try:
        _remove_self_from_syspath()
        if _should_attach():
            _attach()
    except Exception as exc:  # never let debugging break the user's program
        _log("bootstrap error: %r" % (exc,))
    finally:
        _chain_to_user_sitecustomize()


# Auto-run at interpreter startup. Set PYDEBUG_DISABLE_AUTOINSTALL=1 to import
# this module without side effects (used by the unit tests).
if os.environ.get("PYDEBUG_DISABLE_AUTOINSTALL") != "1":
    install()
