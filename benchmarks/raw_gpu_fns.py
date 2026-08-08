import torch
import time
import matplotlib.pyplot as plt
from matplotlib.ticker import ScalarFormatter, NullFormatter

torch._dynamo.config.recompile_limit = 128

def mul_f_provider(repeat):
    def f(x):
        for _ in range(repeat):
            x = x * 3
        return x
    return f


mul_f = torch.compile(mul_f_provider(8))

inputs = torch.randn(2**26, dtype=torch.float32).cuda()
for _ in range(5): mul_f(inputs)