"""Demo for the Python Debug Terminal.

Run this from a Python Debug Terminal and set breakpoints on the marked lines.
The child process should attach as its own separate debug session.
"""
import os
import subprocess
import sys


def add(a, b):
    result = a + b          # <-- set a breakpoint here
    return result


def main():
    print(f"parent pid={os.getpid()}")
    total = 0
    for i in range(5):
        total = add(total, i)   # <-- and here; inspect `total` each iteration
    print(f"parent total={total}")

    # Spawn a child interpreter — it should attach as a second session.
    subprocess.run(
        [sys.executable, "-c", "import os; print(f'child pid={os.getpid()}'); print(2 + 2)"],
        check=True,
    )
    print("done")


if __name__ == "__main__":
    main()
