#include <cuda_fp16.h>
#include <torch/extension.h>

// Packed: one HFMA2 does 2 FMAs
__global__ void packed_kernel(__half2* out, const __half2* in, int n2, int reps) {
    int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i >= n2) return;
    const __half2 a = __float2half2_rn(1.0001f);
    const __half2 b = __float2half2_rn(0.0001f);
    __half2 x0 = in[i], x1 = x0, x2 = x0, x3 = x0;
    #pragma unroll 
    for (int r = 0; r < reps; r++) {
        x0 = __hfma2(x0, a, b);
        x1 = __hfma2(x1, a, b);
        x2 = __hfma2(x2, a, b);
        x3 = __hfma2(x3, a, b);
    }
    out[i] = __hadd2(__hadd2(x0, x1), __hadd2(x2, x3));
}

// Scalar: for comparison — should emit HFMA
__global__ void scalar_kernel(__half* out, const __half* in, int n, int reps) {
    int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i >= n) return;
    __half x0 = in[i], x1 = x0, x2 = x0, x3 = x0;
    const __half a = __float2half(1.0001f);
    const __half b = __float2half(0.0001f);
    #pragma unroll 8
    for (int r = 0; r < reps; ++r) {
        x0 = __hfma(x0, a, b);
        x1 = __hfma(x1, a, b);
        x2 = __hfma(x2, a, b);
        x3 = __hfma(x3, a, b);
    }
    out[i] = __hadd(__hadd(x0, x1), __hadd(x2, x3));
}

void packed(torch::Tensor out, torch::Tensor in, int reps) {
    int n2 = in.numel() / 2;
    int threads = 256, blocks = (n2 + threads - 1) / threads;
    packed_kernel<<<blocks, threads>>>(
        reinterpret_cast<__half2*>(out.data_ptr<at::Half>()),
        reinterpret_cast<const __half2*>(in.data_ptr<at::Half>()), n2, reps);
}

void scalar(torch::Tensor out, torch::Tensor in, int reps) {
    int n = in.numel();
    int threads = 256, blocks = (n + threads - 1) / threads;
    scalar_kernel<<<blocks, threads>>>(
        reinterpret_cast<__half*>(out.data_ptr<at::Half>()),
        reinterpret_cast<const __half*>(in.data_ptr<at::Half>()), n, reps);
}

PYBIND11_MODULE(TORCH_EXTENSION_NAME, m) {
    m.def("packed", &packed);
    m.def("scalar", &scalar);
}