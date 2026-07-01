/**
 * Frame-time and streaming metrics with named captures. Reports are stored on
 * window.__captures so measurements can be pulled out programmatically.
 */

export interface CaptureReport {
  name: string;
  seconds: number;
  frames: number;
  fpsAvg: number;
  frameAvgMs: number;
  frameP50Ms: number;
  frameP95Ms: number;
  frameP99Ms: number;
  frameMaxMs: number;
  longFrames33: number;
  chunkLoads: number;
  chunkReleases: number;
  buildAvgMs?: number;
  buildP95Ms?: number;
  buildMaxMs?: number;
  residentAtEnd?: number;
  trianglesAtEnd?: number;
  extra?: Record<string, number | string>;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[i];
}

export class Metrics {
  fpsEma = 60;
  frameMsEma = 16;
  private capture: { name: string; dts: number[]; t0: number; loads0: number; releases0: number; builds0: number } | null = null;
  reports: Record<string, CaptureReport> = {};
  getStreaming: () => { loads: number; releases: number; buildSamples: number[]; resident: number; triangles: number };

  constructor(getStreaming: Metrics['getStreaming']) {
    this.getStreaming = getStreaming;
    (window as any).__captures = this.reports;
    (window as any).__metrics = this;
  }

  frame(dtMs: number): void {
    const a = Math.min(1, dtMs / 500);
    this.frameMsEma += (dtMs - this.frameMsEma) * a;
    this.fpsEma = 1000 / this.frameMsEma;
    if (this.capture) this.capture.dts.push(dtMs);
  }

  begin(name: string): void {
    const s = this.getStreaming();
    this.capture = {
      name, dts: [], t0: performance.now(),
      loads0: s.loads, releases0: s.releases, builds0: s.buildSamples.length,
    };
  }

  active(): string | null { return this.capture?.name ?? null; }

  end(extra?: Record<string, number | string>): CaptureReport | null {
    if (!this.capture) return null;
    const c = this.capture;
    this.capture = null;
    const s = this.getStreaming();
    const sorted = [...c.dts].sort((a, b) => a - b);
    const sum = c.dts.reduce((a, b) => a + b, 0);
    const builds = s.buildSamples.slice(c.builds0).sort((a, b) => a - b);
    const report: CaptureReport = {
      name: c.name,
      seconds: (performance.now() - c.t0) / 1000,
      frames: c.dts.length,
      fpsAvg: c.dts.length > 0 ? 1000 / (sum / c.dts.length) : 0,
      frameAvgMs: c.dts.length > 0 ? sum / c.dts.length : 0,
      frameP50Ms: percentile(sorted, 50),
      frameP95Ms: percentile(sorted, 95),
      frameP99Ms: percentile(sorted, 99),
      frameMaxMs: sorted[sorted.length - 1] ?? 0,
      longFrames33: c.dts.filter((d) => d > 33.4).length,
      chunkLoads: s.loads - c.loads0,
      chunkReleases: s.releases - c.releases0,
      buildAvgMs: builds.length ? builds.reduce((a, b) => a + b, 0) / builds.length : undefined,
      buildP95Ms: builds.length ? percentile(builds, 95) : undefined,
      buildMaxMs: builds.length ? builds[builds.length - 1] : undefined,
      residentAtEnd: s.resident,
      trianglesAtEnd: s.triangles,
      extra,
    };
    this.reports[c.name] = report;
    // eslint-disable-next-line no-console
    console.log(`[capture:${c.name}]`, JSON.stringify(report));
    return report;
  }
}
