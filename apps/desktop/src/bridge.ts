import type { Greeting } from '@notarium/package-api-contract';
export type { Greeting } from '@notarium/package-api-contract';
export interface DesktopCapabilities {
  apiEnabled: boolean;
}
export interface DesktopBridge {
  getCapabilities(): Promise<DesktopCapabilities>;
  greet(name: string): Promise<Greeting>;
}
