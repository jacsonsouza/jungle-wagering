export type MetricLabels = Readonly<Record<string, string>>;

export interface MetricsPort {
  increment(name: string, labels?: MetricLabels): void;
  observe(name: string, seconds: number, labels?: MetricLabels): void;
}
