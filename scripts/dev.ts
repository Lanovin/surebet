// Lokální spuštění všeho jedním příkazem (bez Dockeru):  npm run dev
//   DATA_SOURCE=sim|real  (výchozí sim = testovací kurzy)
//   WEB=dev|prod|none     (prod = next build + next start, šetří paměť)
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const web = process.env.WEB ?? 'dev';
const colors = ['\x1b[36m', '\x1b[33m', '\x1b[35m', '\x1b[32m'];
const reset = '\x1b[0m';

if (!process.env.DATABASE_URL && existsSync(join(root, 'scripts/local-infra.sh'))) {
  const r = spawnSync(join(root, 'scripts/local-infra.sh'), ['start'], { stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
const mig = spawnSync('npx', ['tsx', 'src/db/migrate.ts'], { cwd: root, stdio: 'inherit' });
if (mig.status !== 0) process.exit(mig.status ?? 1);

const procs: ChildProcess[] = [];
function run(name: string, cmd: string, args: string[], i: number, cwd = root) {
  const p = spawn(cmd, args, { cwd, env: { ...process.env, FORCE_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const prefix = `${colors[i % colors.length]}${name.padEnd(8)}${reset}| `;
  const pipe = (s: NodeJS.ReadableStream) => {
    let buf = '';
    s.on('data', (d) => {
      buf += d.toString();
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const l of lines) process.stdout.write(prefix + l + '\n');
    });
  };
  pipe(p.stdout!);
  pipe(p.stderr!);
  p.on('exit', (code) => process.stdout.write(`${prefix}ukončeno (${code})\n`));
  procs.push(p);
}

run('gateway', 'npx', ['tsx', 'src/services/gateway/main.ts'], 0);
run('detector', 'npx', ['tsx', 'src/services/detector/main.ts'], 1);
setTimeout(() => run('ingest', 'npx', ['tsx', 'src/services/ingest/main.ts'], 2), 1500);
if (web === 'dev') run('web', 'npm', ['run', 'dev', '-w', 'web'], 3);
else if (web === 'prod') {
  if (!existsSync(join(root, 'web/.next/BUILD_ID'))) spawnSync('npm', ['run', 'build', '-w', 'web'], { cwd: root, stdio: 'inherit' });
  run('web', 'npm', ['run', 'start', '-w', 'web'], 3);
}
console.log(`\n  Dashboard: http://localhost:3000   API/WS: http://localhost:3001   zdroj dat: ${process.env.DATA_SOURCE ?? 'sim'}\n`);

let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  for (const p of procs) p.kill('SIGTERM');
  setTimeout(() => process.exit(0), 4000);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
