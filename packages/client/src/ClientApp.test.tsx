import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { ClientApp } from './ClientApp.js';

afterEach(cleanup);

it('works locally without requiring a backend', () => {
  render(<ClientApp platform="web" />);
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: ' Ada ' } });
  expect(screen.getByTestId('local-greeting').textContent).toBe('Hello, Ada!');
  fireEvent.click(screen.getByRole('button', { name: 'Increment' }));
  expect(screen.getByTestId('count').textContent).toBe('Clicks: 1');
  expect(screen.queryByRole('button', { name: 'Ask API' })).toBeNull();
});

it('uses the supplied API and renders its response', async () => {
  let requested = '';
  render(
    <ClientApp
      platform="desktop"
      api={{
        greet: (name) => {
          requested = name;
          return Promise.resolve({ message: 'Hello from API!' });
        },
      }}
    />,
  );
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Ada' } });
  fireEvent.click(screen.getByRole('button', { name: 'Ask API' }));
  expect(await screen.findByText('Hello from API!')).toBeDefined();
  expect(requested).toBe('Ada');
});

it('shows an API failure without substituting a local response', async () => {
  render(
    <ClientApp platform="web" api={{ greet: () => Promise.reject(new Error('Unavailable')) }} />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Ask API' }));
  expect((await screen.findByRole('alert')).textContent).toBe('Unavailable');
});
