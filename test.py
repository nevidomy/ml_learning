import torch
import time

device = torch.device("cuda")

print(f"Device: {device}")
torch.cuda.synchronize()
start = time.perf_counter()
r = torch.zeros(5000, 5000, device=device)
x = torch.rand(5000, 5000, device=device)
for i in range(100):
    r += x @ x
torch.cuda.synchronize()
print(f"r.device: {r.device}")
print(f"Elapsed: {time.perf_counter() - start:.3f} seconds")
