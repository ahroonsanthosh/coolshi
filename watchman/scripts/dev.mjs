// Runs the aggregator and the Vite dev server together.
import { spawn } from 'node:child_process';

const run = (cmd, args) => spawn(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32' });
const procs = [run('node', ['--watch', 'server/index.ts']), run('npx', ['vite'])];
const stop = () => { for (const p of procs) p.kill(); process.exit(); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
