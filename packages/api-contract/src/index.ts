export interface Greeting {
  readonly message: string;
}

export function formatGreeting(subject?: string): Greeting {
  const clean = subject?.trim() || 'world';
  return { message: `Hello, ${clean}!` };
}
