def add(a, b):
    return a + b


total = 0
for i in range(5):
    total = add(total, i)  # loop-body breakpoint target (L7)

print("total is", total)
