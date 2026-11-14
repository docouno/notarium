const { dirname, join } = require('node:path');
module.exports = {
  appId: 'org.notarium.desktop',
  productName: 'Notarium',
  directories: { output: 'release' },
  files: ['dist/**', 'package.json'],
  asar: true,
  extraResources: [
    {
      from: join(
        __dirname,
        '../api/target/debug',
        `notarium-sidecar${process.platform === 'win32' ? '.exe' : ''}`,
      ),
      to: `notarium-sidecar${process.platform === 'win32' ? '.exe' : ''}`,
    },
  ],
  npmRebuild: false,
  electronDist: join(dirname(require.resolve('electron/package.json')), 'dist'),
  linux: { executableName: 'notarium', target: ['dir'] },
};
