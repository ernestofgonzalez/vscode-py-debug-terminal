"""Unit tests for the injected bootstrap's decision logic.

These cover the parts that carry real risk: the attach/skip filtering and the
sys.path hygiene. They use only the standard library (unittest), so they run
without debugpy or any third-party packages:

    python3 -m unittest discover -s pydebug -p 'test_*.py'

We load sitecustomize.py under a throwaway module name with
PYDEBUG_DISABLE_AUTOINSTALL=1 so importing it does not try to attach a debugger.
"""

import importlib.util
import os
import sys
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


if __name__ == "__main__":
    unittest.main()
