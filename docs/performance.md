# Performance comparisons

**Tests › performance** benchmarks a run configuration and compares saved results. Use it to compare two configurations (for example with and without a mod) or the same configuration before and after a code change.

## Running a benchmark

Choose a configuration with the development bridge on, then set:

| Setting | Default | |
| --- | --- | --- |
| Runs | 3 | How many times the whole run repeats. More runs give a better measure of noise |
| Warm-up | 20 s | Time after the world is ready (and after the workload) before measuring |
| Measure | 30 s | Sampling time, one sample per second |
| Workload | None | A scenario from `scenarios/` whose steps run before the warm-up, for example commands that force-load chunks or summon entities |
| Label | Configuration name and commit | |

Each run:

1. Prepares a fresh benchmark world.
   - **Servers:** `level-name` is set to `modsmith-benchmark`, with a fixed seed (4242) and a normal world type, and the previous benchmark world is deleted. The instance's own world is not touched.
   - **Clients:** the world is created through the bridge with the same seed. In `options.txt` the first-run accessibility screen is skipped, `pauseOnLostFocus` is off so the integrated server keeps ticking when the window is in the background, vsync is off and the frame rate is not capped.
   - `server.properties` and `options.txt` go back to their earlier contents when the benchmark ends, including when it fails or is cancelled.
2. Launches the configuration the same way Play does.
3. Measures startup:
   - **Servers:** from the process start to the `Done (…)` line. Minecraft's own reported time is kept as well.
   - **Clients:** to the title screen, plus the time to create and enter the world.
4. Runs the workload scenario, if any, then waits for the warm-up.
5. Samples once a second:
   - tick time (`game.telemetry`, Minecraft's smoothed average);
   - memory in use;
   - on clients, the frame rate.
6. Stops the game.

Per run, the result keeps startup and world load times, mean and 95th percentile tick time, mean frame rate, and mean and peak memory. Across runs it keeps the mean, standard deviation, minimum and maximum of each. Results are saved in `.modsmith/benchmarks/<id>.json` with the git commit of the project.

## Comparing

Tick two results; the first one ticked is the baseline (A). For each metric the table shows A, B and the change. The verdict says whether lower or higher is better for that metric:

- **Better** or **Worse** when the change is larger than the noise threshold;
- **Within noise** otherwise.

The noise threshold is twice the standard error of the difference, `2 × √(sA²/nA + sB²/nB)`, and never less than 2% of the larger mean.

Warnings appear when the two results differ in side, settings, workload, or Minecraft or loader version, or when either has a single run.

## API

| Method | |
| --- | --- |
| `perf.run` | `{ path, profile, runs?, warmupSeconds?, sampleSeconds?, label?, scenario?, seed?, flat? }`. Long-running; the result is the saved benchmark |
| `perf.results` | `{ path }`. Saved results, newest first |
| `perf.compare` | `{ path, a, b }` |
| `perf.delete` | `{ path, id }` |
