MARKER = "start"  # first executed statement: first-line breakpoint target (L1)


def add(a, b):
    result = a + b  # set-before-launch breakpoint target inside add (L5)
    return result


def main():
    total = add(2, 3)
    print("total is", total)


if __name__ == "__main__":
    main()
