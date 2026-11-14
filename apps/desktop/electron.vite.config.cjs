const { resolve } = require('node:path');
module.exports = async () => {
  const { devkitWorkspaceSource } = await import('@docouno/env/vite');
  const { default: react } = await import('@vitejs/plugin-react');
  return {
    main: { build: { outDir: 'dist/main' } },
    preload: {
      build: {
        outDir: 'dist/preload',
        rolldownOptions: { output: { entryFileNames: 'index.cjs', format: 'cjs' } },
      },
    },
    renderer: {
      plugins: [devkitWorkspaceSource(__dirname), react()],
      cacheDir: resolve(__dirname, 'node_modules/.cache/devkit-electron-vite'),
      resolve: { dedupe: ['react', 'react-dom'] },
      server: { port: 5173, strictPort: true },
      build: { outDir: resolve(__dirname, 'dist/renderer'), minify: true },
    },
  };
};
