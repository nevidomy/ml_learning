import torch, time, glob, os, subprocess
from torch.utils.cpp_extension import load

m = load(name="hfma2", sources=["/home/nevidomy/work/ml_learning/benchmarks/hfma2.cu"],
         extra_cuda_cflags=["-O3", "-lineinfo"], verbose=True)

n = 2**26
x = torch.randn(n, dtype=torch.float16, device='cuda')
out = torch.empty_like(x)

f = m.scalar
#f = m.packed

for _ in range(5): f(out, x, 8)

print("Done")