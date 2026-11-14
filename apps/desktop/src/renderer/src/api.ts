import type { DesktopBridge, Greeting } from '../../bridge.js';
export async function greet(
  name: string,
  bridge: DesktopBridge = window.desktop,
): Promise<Greeting> {
  const value: unknown = await bridge.greet(name);
  if (
    !value ||
    typeof value !== 'object' ||
    !('message' in value) ||
    typeof value.message !== 'string' ||
    !value.message
  ) {
    throw new Error('Desktop returned an invalid greeting.');
  }
  return { message: value.message };
}
