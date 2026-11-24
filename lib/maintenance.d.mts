export interface MaintenanceConfig {
  active: boolean;
  invalidMode: boolean;
  retryAfterSeconds: number;
  lineUrl: string | null;
}
export function maintenanceConfig(env?: Record<string, string | undefined>): MaintenanceConfig;
export function maintenanceHtml(config: MaintenanceConfig): string;
export const DEFAULT_RETRY_AFTER_SECONDS: number;
