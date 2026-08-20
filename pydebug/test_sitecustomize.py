"""Unit tests for the injected bootstrap's decision logic.

These cover the parts that carry real risk: the attach/skip filtering and the
sys.path hygiene. They use only the standard library (unittest), so they run
without debugpy or any third-party packages:

    python3 -m unittest discover -s pydebug -p 'test_*.py'

We load sitecustomize.py under a throwaway module name with
PYDEBUG_DISABLE_AUTOINSTALL=1 so importing it does not try to attach a debugger.
"""

import importlib.util
import json
import os
import socket
import sys
import threading
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))


def _load_bootstrap():
    os.environ["PYDEBUG_DISABLE_AUTOINSTALL"] = "1"
    spec = importlib.util.spec_from_file_location(
        "pydebug_bootstrap_under_test", os.path.join(_HERE, "sitecustomize.py")
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


boot = _load_bootstrap()


class EnvArgvTestCase(unittest.TestCase):
    """Base class that snapshots and restores global interpreter state."""

    def setUp(self):
        self._argv = list(sys.argv)
        self._path = list(sys.path)
        self._env = dict(os.environ)

    def tearDown(self):
        sys.argv[:] = self._argv
        sys.path[:] = self._path
        os.environ.clear()
        os.environ.update(self._env)

    def _configure(self, ipc="127.0.0.1:5555", skip=None):
        os.environ["PYDEBUG_IPC"] = ipc
        if skip is None:
            os.environ.pop("PYDEBUG_SKIP", None)
        else:
            os.environ["PYDEBUG_SKIP"] = os.pathsep.join(skip)


class ShouldAttachTests(EnvArgvTestCase):
    def test_skips_when_ipc_is_unset(self):
        os.environ.pop("PYDEBUG_IPC", None)
        sys.argv = ["app.py"]
        self.assertFalse(boot._should_attach())

    def test_attaches_a_normal_script(self):
        self._configure()
        sys.argv = ["/home/me/app.py"]
        self.assertTrue(boot._should_attach())

    def test_skips_the_debugpy_adapter_subprocess(self):
        self._configure()
        sys.argv = ["/x/debugpy/adapter/__main__.py"]
        self.assertFalse(boot._should_attach())

    def test_skips_pydevd(self):
        self._configure()
        sys.argv = ["python", "-m", "pydevd", "--port", "1"]
        self.assertFalse(boot._should_attach())

    def test_skips_a_listed_program_by_basename(self):
        self._configure(skip=["ruff", "black"])
        sys.argv = ["/usr/local/bin/ruff", "check", "."]
        self.assertFalse(boot._should_attach())

    def test_skips_a_listed_program_by_path_component(self):
        # `python -m pip` has argv[0] == .../site-packages/pip/__main__.py
        self._configure(skip=["pip"])
        sys.argv = ["/venv/lib/python3.13/site-packages/pip/__main__.py", "install", "x"]
        self.assertFalse(boot._should_attach())

    def test_does_not_skip_an_unlisted_program(self):
        self._configure(skip=["ruff"])
        sys.argv = ["/usr/bin/python", "app.py"]
        self.assertTrue(boot._should_attach())


class SysPathHygieneTests(EnvArgvTestCase):
    def test_norm_absolutizes_and_normcases(self):
        self.assertEqual(
            boot._norm("foo/../bar"),
            os.path.normcase(os.path.abspath("foo/../bar")),
        )

    def test_remove_self_drops_injector_dir_from_syspath(self):
        injector_dir = os.path.dirname(os.path.abspath(boot.__file__))
        sys.path.insert(0, injector_dir)
        boot._remove_self_from_syspath()
        normalized = [boot._norm(p) for p in sys.path]
        self.assertNotIn(boot._norm(injector_dir), normalized)


class AnnounceTests(EnvArgvTestCase):
    def test_announce_sends_the_payload_and_returns_true(self):
        os.environ["PYDEBUG_TOKEN"] = "tok-xyz"
        received = {}

        listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        listener.bind(("127.0.0.1", 0))
        listener.listen(1)
        host, port = listener.getsockname()

        def serve():
            conn, _ = listener.accept()
            with conn:
                data = b""
                while b"\n" not in data:
                    chunk = conn.recv(1024)
                    if not chunk:
                        break
                    data += chunk
                received["line"] = data.split(b"\n", 1)[0]
                conn.sendall(b'{"ok": true}\n')

        thread = threading.Thread(target=serve, daemon=True)
        thread.start()
        try:
            ok = boot._announce(host, port, "127.0.0.1", 5678)
        finally:
            thread.join(timeout=2)
            listener.close()

        self.assertTrue(ok)
        payload = json.loads(received["line"].decode("utf-8"))
        self.assertEqual(payload["token"], "tok-xyz")
        self.assertEqual(payload["port"], 5678)
        self.assertEqual(payload["host"], "127.0.0.1")
        self.assertIn("pid", payload)

    def test_announce_returns_false_when_server_is_unreachable(self):
        # Bind then immediately close to obtain an almost-certainly-free port.
        probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        probe.bind(("127.0.0.1", 0))
        _, port = probe.getsockname()
        probe.close()
        self.assertFalse(boot._announce("127.0.0.1", port, "127.0.0.1", 5678))


class ResolveDebugpyTests(EnvArgvTestCase):
    def test_returns_none_when_debugpy_is_unavailable(self):
        os.environ.pop("PYDEBUG_DEBUGPY_PATH", None)
        try:
            import debugpy  # noqa: F401

            self.skipTest("debugpy is importable in this interpreter")
        except ImportError:
            pass
        self.assertIsNone(boot._resolve_debugpy())


if __name__ == "__main__":
    unittest.main()
