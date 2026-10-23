// NestJS needs decorator metadata, which esbuild-based runners (tsx) do not emit. So: compile with tsc in watch mode, restart node on output changes.
const { spawn, execSync } = require('child_process');
const run = (cmd, args) => spawn(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32' });
execSync('npx tsc -p tsconfig.build.json', { stdio: 'inherit' }); execSync('node scripts/copy-assets.js', { stdio: 'inherit' });
const tsc = run('npx', ['tsc', '-p', 'tsconfig.build.json', '--watch', '--preserveWatchOutput']);
const app = run('node', ['--watch', '--watch-path=dist', 'dist/main.js']);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { tsc.kill(); app.kill(); process.exit(0); });
