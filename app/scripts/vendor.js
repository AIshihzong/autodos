// Bundles the Feishu SDK into one file, so the desktop app can ship the server without node_modules.
import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
await build({
  stdin: { contents: "export { registerApp, createLarkChannel } from '@larksuiteoapi/node-sdk';", resolveDir: root, loader: 'js' },
  bundle: true,
  platform: 'node',
  format: 'cjs', // the SDK is CommonJS and uses require and __dirname
  target: 'node20',
  minify: true,
  legalComments: 'linked',
  outfile: path.join(root, 'server', 'vendor', 'lark.cjs'),
  logLevel: 'warning',
});
console.log('server/vendor/lark.cjs ready');
