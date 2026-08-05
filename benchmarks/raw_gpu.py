import torch
import time
import matplotlib.pyplot as plt
from matplotlib.ticker import ScalarFormatter, NullFormatter

def runBenchmark(
        func_provider,     # provides a function fused x times
        inputs,            # inputs to the function (tensor on device)
        iterations,        # number of iterations to run per instance
        single_call_flops, # number of flops per single call
        fusion_range,      # inclusive [start, end] range of fusion to test
        steps,             # number of steps to test between start and end
        verbose=False):
    if verbose:
        print(f"Running benchmark")
    def get_log_splits(start, end, n):
        r = [int(start * (end/start)**(i/n)) for i in range(n+1)]
        for i in range(1,len(r)):
            if(r[i] <= r[i-1]):
                r[i] = r[i-1] + 1
        return r

    fusion_values = get_log_splits(fusion_range[0], fusion_range[1], steps)
    stats = []
    for fusion_value in fusion_values:
        func = func_provider(fusion_value)
        torch.cuda.synchronize()
        start = time.time()
        for _ in range(iterations):
            func(inputs)
        torch.cuda.synchronize()
        end = time.time()

        t_iter = (end - start) / iterations
        iter_per_sec = 1 / t_iter
        flops = iter_per_sec * single_call_flops * fusion_value
        bytes_per_second = iter_per_sec * inputs.numel() * inputs.element_size() * 2

        stats.append((
            fusion_value,
            iter_per_sec,
            flops * 1e-12,             # TFLOPS
            bytes_per_second*1e-9))    # GB/s
        if verbose:
            print(f"Fusion: {fusion_value}, Iter/sec: {iter_per_sec}, FLOPS: {flops * 1e-12}, Mem B/W: {bytes_per_second*1e-9}")
    return stats

def plot_stats(stats):
    def make_plot(name, value_name, x_data, y_data):
        plt.plot(x_data, y_data, label=name)
        plt.xlabel("Fuses")
        plt.ylabel(value_name)
        plt.legend()
        plt.xscale("log", base=2)
        ax = plt.gca()
        ax.set_xticks(x_data)
        ax.xaxis.set_major_formatter(ScalarFormatter())
        ax.xaxis.set_minor_formatter(NullFormatter())
        ax.ticklabel_format(axis="y", style="plain")
        plt.show()

    make_plot("Compute", "FLOPS (TF/s)", stats[:, 0], stats[:, 3])
    make_plot("Memory", "Mem B/W (GB/s)", stats[:, 0], stats[:, 4])


def mul_f_provider(repeat):
    def f(x):
        for _ in range(repeat):
            x = x * 2
        return x
    return torch.compile(f)

plot_stats(runBenchmark(
    func_provider=mul_f_provider,
    inputs=torch.randn(2**26, dtype=torch.float32).cuda(),
    iterations=100,
    single_call_flops=1,
    fusion_range=[1, 500],
    steps=20,
))