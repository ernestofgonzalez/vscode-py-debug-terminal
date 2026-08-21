def work(x):
    y = x * 2  # child-subprocess breakpoint target (L2)
    return y


if __name__ == "__main__":
    print("child result", work(21))
