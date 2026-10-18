import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const outDir = path.resolve('docs/evidence/rc3');
if (!fs.existsSync(outDir)) {
  fs.mkdirSync(outDir, { recursive: true });
}

function runAndSave(cmd: string, filename: string) {
  console.log(`Running: ${cmd}`);
  let output = '';
  try {
    output = execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err: unknown) {
    const errorObj = err as { stdout?: Buffer | string; stderr?: Buffer | string };
    output = (errorObj.stdout?.toString() ?? '') + (errorObj.stderr?.toString() ?? '');
  }
  const target = path.join(outDir, filename);
  fs.writeFileSync(target, output, { encoding: 'utf8' });
  console.log(`Saved ${filename} (${Buffer.byteLength(output, 'utf8')} bytes, UTF-8)`);
}

runAndSave('pnpm typecheck', 'typecheck.txt');
runAndSave('pnpm lint', 'lint.txt');
runAndSave('pnpm test', 'test.txt');
runAndSave('pnpm attack-suite', 'attack-suite.txt');
runAndSave('pnpm test:concurrency', 'concurrency.txt');
console.log('All evidence generated in UTF-8 successfully.');
