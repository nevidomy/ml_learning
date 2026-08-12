"""Fit your own scaling curve instead of borrowing someone else's constants.

Chinchilla's parametric form:

    L(N) = E + A / N**alpha          (along the compute-optimal ray, D = 20N)

  E      irreducible loss -- the entropy of this corpus under this tokenizer.
         This is the real floor, and it is what the bigram baseline is NOT.
  A/N^a  the reducible part your model size buys down.

Published constants (E=1.69 etc.) are for English under a different
tokenizer and do not transfer. The exponent alpha is more portable than E,
but fit both from your own runs.

Needs >= 3 points to fit 3 parameters; 4-5 gives you a residual worth reading.
"""

import numpy as np


def fit_scaling_prefiction(points, predict=(10e6, 30e6, 100e6), verbose=True):
    """points: [(n_params, loss_nats_per_token), ...] -- all at the SAME
    tokenizer and roughly compute-optimal token budgets."""
    N = np.array([p[0] for p in points], dtype=np.float64)
    L = np.array([p[1] for p in points], dtype=np.float64)
    assert len(N) >= 3, "need at least 3 runs to fit E, A, alpha"

    # grid over E, then a linear fit of log(L-E) vs log(N)
    best = None
    for E in np.linspace(0.0, L.min() * 0.999, 4000):
        y = np.log(L - E)
        x = np.log(N)
        a, b = np.polyfit(x, y, 1)                # y = a*x + b
        resid = np.sum((y - (a * x + b)) ** 2)
        if best is None or resid < best[0]:
            best = (resid, E, -a, np.exp(b))
    resid, E, alpha, A = best

    if verbose:
        print(f"L(N) = {E:.4f} + {A:.4g} / N**{alpha:.4f}")
        print(f"  irreducible E   {E:.4f} nats/token")
        print(f"  exponent alpha  {alpha:.4f}")
        print(f"  fit residual    {resid:.3e}\n")
        print(f"  {'N':>12}{'observed':>11}{'fitted':>10}{'err':>9}")
        for n, l in zip(N, L):
            f = E + A / n ** alpha
            print(f"  {n:>12,.0f}{l:>11.4f}{f:>10.4f}{l-f:>+9.4f}")
        if predict:
            print(f"\n  {'N':>12}{'predicted':>11}")
            for n in predict:
                print(f"  {n:>12,.0f}{E + A / n**alpha:>11.4f}")
    return dict(E=E, A=A, alpha=alpha, resid=resid)


def tk_to_bpc(loss, cpt):
    return loss / cpt / np.log(2)


if __name__ == "__main__":
    # recover known constants from synthetic points
    E_true, A_true, a_true = 1.20, 900.0, 0.36
    Ns = np.array([2.6e6, 8e6, 25e6, 80e6])
    Ls = E_true + A_true / Ns ** a_true
    fit = fit_scaling_prefiction(list(zip(Ns, Ls)), predict=(100e6,))
    print()
    for k, true in [("E", E_true), ("alpha", a_true)]:
        err = abs(fit[k] - true) / true
        print(f"  {k:6} fitted {fit[k]:.4f}  true {true:.4f}  err {err*100:.2f}%")
        assert err < 0.05, f"{k} not recovered"

    print("\nwith noise (+-0.01 nats, realistic eval jitter):")
    rng = np.random.default_rng(0)
    Ln = Ls + rng.normal(0, 0.01, size=Ls.shape)
    f2 = fit_scaling_prefiction(list(zip(Ns, Ln)), predict=(100e6,), verbose=False)
    print(f"  E {f2['E']:.4f} (true {E_true})   "
          f"alpha {f2['alpha']:.4f} (true {a_true})")
    print(f"  predicted L(100M) = {f2['E'] + f2['A']/100e6**f2['alpha']:.4f}"
          f"  vs true {E_true + A_true/100e6**a_true:.4f}")