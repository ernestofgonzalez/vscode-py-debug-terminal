def greet(name):
    message = "hello " + name  # logpoint target (L2): logMessage "greeting {name}"
    return message


for who in ["a", "b", "c"]:
    greet(who)

print("done")
