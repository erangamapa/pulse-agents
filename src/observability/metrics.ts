export type Labels = Readonly<Record<string, string>>;

export interface Metrics {
  increment(name: string, labels?: Labels, by?: number): void;
  observe(name: string, value: number, labels?: Labels): void;
}

export const noopMetrics: Metrics = {
  increment: () => undefined,
  observe: () => undefined,
};

const keyFor = (name: string, labels: Labels = {}): string => {
  const parts = Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([label, value]) => `${label}=${value}`);
  return parts.length === 0 ? name : `${name}{${parts.join(',')}}`;
};

/** Holds values in process. Used in tests and as the default until a backend is wired in. */
export class InMemoryMetrics implements Metrics {
  private readonly counters = new Map<string, number>();
  private readonly histograms = new Map<string, number[]>();

  increment(name: string, labels?: Labels, by = 1): void {
    const key = keyFor(name, labels);
    this.counters.set(key, (this.counters.get(key) ?? 0) + by);
  }

  observe(name: string, value: number, labels?: Labels): void {
    const key = keyFor(name, labels);
    this.histograms.set(key, [...(this.histograms.get(key) ?? []), value]);
  }

  counter(name: string, labels?: Labels): number {
    return this.counters.get(keyFor(name, labels)) ?? 0;
  }

  samples(name: string, labels?: Labels): readonly number[] {
    return this.histograms.get(keyFor(name, labels)) ?? [];
  }
}
