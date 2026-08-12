"""Every statistical claim in the sweep analysis, verified by simulation.

Run this. Each section states a formula, then checks it by brute force against
10,000 simulated experiments. If the formula and the simulation agree, the
formula is right and you can stop taking it on faith.

Uses the measured values from the Phase-0 sweeps:
    sigma_cosine = 0.0161 bpc     sigma_WSD = 0.0081 bpc     rho = 0.76
"""

import math
import random
import statistics as st

TRIALS = 10_000
SIGMA = 0.0161          # measured seed-to-seed sd, cosine arm
MEAN = 1.7302
random.seed(0)


def draw(n, mean=MEAN, sigma=SIGMA):
    """One experiment: n runs with different seeds."""
    return [random.gauss(mean, sigma) for _ in range(n)]


def rule(title):
    print(f"\n{'='*70}\n{title}\n{'='*70}")


# ---------------------------------------------------------------------------
rule("1. BESSEL'S CORRECTION -- why n-1 and not n")
print("""
Claim: dividing by n UNDERESTIMATES the variance, because xbar is fitted to
the same data. Dividing by n-1 is unbiased. This is a theorem, not a fudge:
E[sum (x - xbar)^2] = (n-1) * sigma^2 exactly.
""")
print(f"  true variance = {SIGMA**2:.8f}")
for n in (3, 8, 30):
    over_n, over_n1 = [], []
    for _ in range(TRIALS):
        x = draw(n)
        m = st.mean(x)
        ss = sum((v - m) ** 2 for v in x)
        over_n.append(ss / n)
        over_n1.append(ss / (n - 1))
    print(f"  n={n:>2}: /n gives {st.mean(over_n):.8f} "
          f"({st.mean(over_n)/SIGMA**2:.3f}x true, predicted {(n-1)/n:.3f}x)"
          f"   /(n-1) gives {st.mean(over_n1):.8f} "
          f"({st.mean(over_n1)/SIGMA**2:.3f}x)")


# ---------------------------------------------------------------------------
rule("2. SE OF THE MEAN -- SE = sigma / sqrt(n)")
print("""
Compute the mean of n runs, many times over, and look at how much that mean
moves. That spread IS the standard error.
""")
for n in (1, 4, 8, 16):
    means = [st.mean(draw(n)) for _ in range(TRIALS)]
    print(f"  n={n:>2}: simulated sd of the mean {st.stdev(means):.5f}   "
          f"formula sigma/sqrt(n) = {SIGMA/math.sqrt(n):.5f}")


# ---------------------------------------------------------------------------
rule("3. THE SD IS ITSELF UNCERTAIN -- SD(s) = sigma / sqrt(2(n-1))")
print("""
s is computed from data, so it wobbles too. This is why 'sigma = 0.0161' is
not a fact but an estimate. With n=8 the wobble is ~27% of sigma.
""")
for n in (4, 8, 30):
    ss = [st.stdev(draw(n)) for _ in range(TRIALS)]
    sim, pred = st.stdev(ss), SIGMA / math.sqrt(2 * (n - 1))
    lo = sorted(ss)[int(0.025 * TRIALS)]
    hi = sorted(ss)[int(0.975 * TRIALS)]
    print(f"  n={n:>2}: simulated SD(s) {sim:.5f}   formula {pred:.5f}   "
          f"rel {pred/SIGMA:.1%}")
    print(f"        95% of estimates land in [{lo:.4f}, {hi:.4f}] "
          f"= [{lo/SIGMA:.2f}x, {hi/SIGMA:.2f}x] of true sigma")


# ---------------------------------------------------------------------------
rule("4. WHAT A p-VALUE MEANS")
print("""
Simulate the null hypothesis: two arms that are TRULY IDENTICAL. How often
does noise alone produce a difference as large as the one you observed?
""")
observed = 0.0793
for k in (1, 3, 8):
    diffs = [abs(st.mean(draw(k)) - st.mean(draw(k))) for _ in range(TRIALS)]
    big = sum(1 for d in diffs if d >= observed)
    p95 = sorted(diffs)[int(0.95 * TRIALS)]
    print(f"  k={k}: with NO real effect, 95% of observed diffs are below "
          f"{p95:.4f} bpc")
    print(f"        diffs >= your observed {observed:.4f}: "
          f"{big}/{TRIALS} = {big/TRIALS:.4%}")
print("""
  Your paired test gave p = 3.7e-08. Unpaired simulation cannot even reach
  that far into the tail with 10,000 trials -- which is the point.""")


# ---------------------------------------------------------------------------
rule("5. POWER AND MDE -- why the constant is 2.80")
print("""
Power = probability of detecting a real effect. MDE = the smallest effect
detected 80% of the time.  MDE = (1.96 + 0.84) * SE(diff),  SE = sigma*sqrt(2/k)
""")
Z = 1.9600 + 0.8416
for k in (1, 3, 5, 8):
    se = SIGMA * math.sqrt(2 / k)
    mde = Z * se
    for effect, label in ((mde, "at the MDE"), (mde / 2, "half the MDE")):
        hits = 0
        for _ in range(TRIALS):
            a = st.mean(draw(k, MEAN + effect))
            b = st.mean(draw(k, MEAN))
            if abs(a - b) > 1.96 * se:
                hits += 1
        print(f"  k={k}: effect {effect:.4f} ({label:<13}) -> detected "
              f"{hits/TRIALS:.1%} of the time")
    print(f"        (MDE formula says {mde:.4f} should give 80%)")


# ---------------------------------------------------------------------------
rule("6. PAIRING -- why rho = 0.76 is worth 4.2x")
print("""
A seed has a 'personality' that carries across arms: a seed that trains well
under cosine also trains well under WSD. Subtracting seed-by-seed removes it.

  Var(diff) = 2*sigma^2*(1-rho)/k
""")
RHO = 0.76
for k in (3, 5):
    unpaired, paired = [], []
    for _ in range(TRIALS):
        # unpaired: independent seeds in each arm
        unpaired.append(st.mean(draw(k)) - st.mean(draw(k, MEAN)))
        # paired: shared seed effect with correlation rho
        d = []
        for _ in range(k):
            shared = random.gauss(0, SIGMA * math.sqrt(RHO))
            ea = random.gauss(0, SIGMA * math.sqrt(1 - RHO))
            eb = random.gauss(0, SIGMA * math.sqrt(1 - RHO))
            d.append((MEAN + shared + ea) - (MEAN + shared + eb))
        paired.append(st.mean(d))
    su, sp = st.stdev(unpaired), st.stdev(paired)
    print(f"  k={k}: SE unpaired {su:.5f}   SE paired {sp:.5f}   "
          f"ratio {su/sp:.2f}x")
    print(f"        formulas: {SIGMA*math.sqrt(2/k):.5f} vs "
          f"{SIGMA*math.sqrt(2*(1-RHO)/k):.5f}   "
          f"predicted {1/math.sqrt(1-RHO):.2f}x")


# ---------------------------------------------------------------------------
rule("7. YOUR ACTUAL DECISION TABLE")
print("""
Seeds needed to detect an effect of size D, at 80% power, 95% significance:

    k = 2 * sigma^2 * (1.96+0.84)^2 * (1-rho) / D^2
""")
print(f"  {'effect':>8} | {'cosine sd=0.0161':>26} | {'WSD sd=0.0081':>26}")
print(f"  {'(bpc)':>8} | {'unpaired':>12}{'paired':>14} | "
      f"{'unpaired':>12}{'paired':>14}")
print("  " + "-" * 68)
for D in (0.010, 0.020, 0.030, 0.050, 0.080):
    row = f"  {D:>8.3f} |"
    for sg in (0.0161, 0.0081):
        for rho in (0.0, RHO):
            k = 2 * sg**2 * Z**2 * (1 - rho) / D**2
            row += f"{math.ceil(k):>13}"
        row += " |"
    print(row)
print("""
  Read: with WSD and paired seeds, 3 seeds per arm detects 0.010 bpc.
  With cosine and unpaired seeds, the same effect needs 41.""")