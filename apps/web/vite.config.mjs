import { env } from 'node:process';
import { devkitWorkspaceSource } from '@docouno/env/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
export default defineConfig({
  plugins: [devkitWorkspaceSource(), react()],
  cacheDir: 'node_modules/.cache/devkit-vite',
  resolve: { dedupe: ['react', 'react-dom'] },
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    ...(env.DEVKIT_API_TARGET ? { proxy: { '/api': env.DEVKIT_API_TARGET } } : {}),
  },
});
