import { describe, expect, it } from 'vitest';
import { compareBenchmarks, percentile, round3, stats, summarizeRuns } from '../src/core/perf';

describe('performance comparisons', () => {
  it('summarizes runs', () => {
    expect(stats([10, 12, 14])).toEqual({ mean: 12, stdev: 2, min: 10, max: 14, n: 3 });
    expect(stats([])).toBeNull();
    expect(percentile([5, 1, 3, 2, 4], 0.95)).toBe(5);
    expect(round3(-1.23456)).toBe(-1.235);
    expect(summarizeRuns([{ msptMean: 10 }, { msptMean: 12, fpsMean: 60 }])).toEqual({ msptMean: { mean: 11, stdev: 1.414, min: 10, max: 12, n: 2 }, fpsMean: { mean: 60, stdev: 0, min: 60, max: 60, n: 1 } });
  });

  it('flags only differences larger than the noise', () => {
    const base = { id: 'a', label: 'A', profile: 'p', createdAt: 'x', commit: null, side: 'server', settings: { runs: 3 }, environment: {} };
    const a = { ...base, summary: { msptMean: { mean: 10, stdev: 0.5, min: 0, max: 0, n: 3 }, memoryMeanMb: { mean: 1000, stdev: 10, min: 0, max: 0, n: 3 }, fpsMean: { mean: 100, stdev: 1, min: 0, max: 0, n: 3 } } };
    const b = { ...base, id: 'b', summary: { msptMean: { mean: 8, stdev: 0.5, min: 0, max: 0, n: 3 }, memoryMeanMb: { mean: 1005, stdev: 10, min: 0, max: 0, n: 3 }, fpsMean: { mean: 80, stdev: 1, min: 0, max: 0, n: 3 } } };
    const c = compareBenchmarks(a, b);
    expect(c.metrics.map((m) => `${m.key}:${m.verdict}:${m.deltaPct}`)).toEqual(['msptMean:better:-20', 'fpsMean:worse:-20', 'memoryMeanMb:same:0.5']);
    expect(c.warnings).toEqual([]);
    expect(compareBenchmarks(a, { ...b, side: 'client', settings: { runs: 1 } }).warnings).toEqual(['The two results are from different sides (client and server).', 'The benchmark settings differ (runs).', 'With a single run there is no measure of run-to-run noise; small differences may not be real.']);
  });
});
