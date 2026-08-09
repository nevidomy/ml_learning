"""Demo: simulates a training loop logging to trainui, including a pause/resume.

Start the server first:  python -m trainui.server
Then run:                python -m trainui.example
"""
import math
import random
import time

from trainui.client import SequenceError, Tracker


def main():
    tracker = Tracker(
        model_id="demo-model",
        description=f"Demo training run started {time.strftime('%Y-%m-%d %H:%M')}",
        param_count=3_200_000,
        context_width=64,
    )
    run = tracker.start_run()
    print(f"run id: {run.id} — open http://127.0.0.1:8501/#/runs/{run.id}")

    try:
        for it in range(1, 301):
            loss = 4.5 * math.exp(-it / 120) + 0.4 + random.uniform(-0.05, 0.05)
            lr = 3e-4 * min(1.0, it / 50) * (0.5 ** (it // 100))
            metrics = {"train_loss": loss, "lr": lr, "grad_norm": random.uniform(0.1, 2.0)}
            if it % 25 == 0:
                metrics["test_loss"] = loss * 1.1 + random.uniform(0, 0.1)
            run.log(iteration=it, batches=32, **metrics)
            time.sleep(0.05)

            if it == 150:
                print("simulating a 5s pause + crash…")
                time.sleep(5)
                # simulate a restarted process whose local seq reset to 1
                run._seq = 1
                try:
                    run.log(iteration=151, batches=32, train_loss=1.0)
                except SequenceError as e:
                    print(f"sequence conflict as expected: {e}")
                    run.resume()  # marks the pause, adopts the server's expected seq
                    print(f"resumed at seq {run._seq}")
    finally:
        run.finish()
    print("done")


if __name__ == "__main__":
    main()
