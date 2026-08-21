import os
import subprocess
import sys

# Launch child.py as a real subprocess. It inherits this process's environment
# (PYTHONPATH + PYDEBUG_* rendezvous coords), so it runs our sitecustomize,
# phones home, and attaches as its own debug session -- purely via environment
# inheritance, with no debugpy subprocess/fork patching involved.
here = os.path.dirname(os.path.abspath(__file__))
child = os.path.join(here, "child.py")
subprocess.run([sys.executable, child], check=True)
print("parent done")
