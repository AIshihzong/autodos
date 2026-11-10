// Runs the API server and the Vite dev server together.
import { spawn } from 'node:child_process';
const run = (cmd, args) => spawn(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32' });
const procs = [run('node', ['--watch', 'server/index.js']), run('npx', ['vite'])];
const bye = () => (procs.forEach((p) => p.kill()), process.exit(0));
process.on('SIGINT', bye);
process.on('SIGTERM', bye);
