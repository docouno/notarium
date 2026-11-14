import { useEffect, useRef, useState } from 'react';
import type { Greeting } from '@notarium/package-api-contract';

export interface ClientApi {
  greet(name: string): Promise<Greeting>;
}

type RemoteState = { phase: 'idle' | 'loading' } | { phase: 'ready' | 'error'; message: string };

export function ClientApp({ api, platform }: { api?: ClientApi; platform: string }) {
  const [name, setName] = useState('world');
  const [count, setCount] = useState(0);
  const [remote, setRemote] = useState<RemoteState>({ phase: 'idle' });
  const request = useRef(0);
  useEffect(
    () => () => {
      request.current += 1;
    },
    [],
  );

  function requestGreeting() {
    if (!api) {
      return;
    }
    const current = ++request.current;
    setRemote({ phase: 'loading' });
    api.greet(name).then(
      (reply) => {
        if (request.current === current) {
          setRemote({ phase: 'ready', message: reply.message });
        }
      },
      (error: unknown) => {
        if (request.current === current) {
          setRemote({
            phase: 'error',
            message: error instanceof Error ? error.message : 'API request failed.',
          });
        }
      },
    );
  }

  return (
    <main>
      <p className="eyebrow">Devkit · {platform}</p>
      <h1>A small app, ready to change.</h1>
      <p>One interface for local interaction and an optional API connection.</p>
      <section className="card" aria-label="Local interaction">
        <label htmlFor="name">Name</label>
        <input
          id="name"
          value={name}
          maxLength={80}
          onChange={(event) => setName(event.target.value)}
        />
        <output data-testid="local-greeting">Hello, {name.trim() || 'world'}!</output>
        <button type="button" onClick={() => setCount((value) => value + 1)}>
          Increment
        </button>
        <span data-testid="count">Clicks: {count}</span>
      </section>
      {api && (
        <section className="api-panel" aria-label="API greeting">
          <h2>API connection</h2>
          <button type="button" onClick={requestGreeting} disabled={remote.phase === 'loading'}>
            {remote.phase === 'loading' ? 'Requesting…' : 'Ask API'}
          </button>
          {remote.phase === 'ready' && <p role="status">{remote.message}</p>}
          {remote.phase === 'error' && <p role="alert">{remote.message}</p>}
        </section>
      )}
    </main>
  );
}
