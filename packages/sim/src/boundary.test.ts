import { describe, it, expect } from 'vitest';
import { ESLint, type Linter } from 'eslint';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('Architectural Boundary & Invariant Verifications (INV-1, AC-7)', { timeout: 60000 }, () => {
  const rootDir = path.resolve(__dirname, '../../../');
  const eslint = new ESLint({ cwd: rootDir });

  it('INV-1 / AC-7: apps/agent must NEVER import @mandatepay/paypal (ESLint path restriction)', async () => {
    const code = "import { PayPalClient } from '@mandatepay/paypal';\nexport const x = PayPalClient;\n";
    const results = await eslint.lintText(code, {
      filePath: path.join(rootDir, 'apps/agent/src/violating-import.ts'),
    });

    const messages = results[0]?.messages ?? [];
    const restrictedErrors = messages.filter((m: Linter.LintMessage) => m.ruleId === 'no-restricted-imports');

    expect(restrictedErrors.length).toBeGreaterThan(0);
    expect(restrictedErrors.some((m: Linter.LintMessage) => m.message.includes('Security boundary violation'))).toBe(true);
  });

  it('INV-1 / AC-7: apps/agent must NEVER import packages/paypal via relative path', async () => {
    const code = "import { PayPalClient } from '../../packages/paypal';\nexport const x = PayPalClient;\n";
    const results = await eslint.lintText(code, {
      filePath: path.join(rootDir, 'apps/agent/src/violating-relative-import.ts'),
    });

    const messages = results[0]?.messages ?? [];
    const restrictedErrors = messages.filter((m: Linter.LintMessage) => m.ruleId === 'no-restricted-imports');

    expect(restrictedErrors.length).toBeGreaterThan(0);
    expect(restrictedErrors.some((m: Linter.LintMessage) => m.message.includes('Security boundary violation'))).toBe(true);
  });

  it('INV-1 / AC-7: apps/agent must NEVER import external @paypal/* SDKs', async () => {
    const code = "import paypal from '@paypal/checkout-server-sdk';\nexport const x = paypal;\n";
    const results = await eslint.lintText(code, {
      filePath: path.join(rootDir, 'apps/agent/src/violating-sdk-import.ts'),
    });

    const messages = results[0]?.messages ?? [];
    const restrictedErrors = messages.filter((m: Linter.LintMessage) => m.ruleId === 'no-restricted-imports');

    expect(restrictedErrors.length).toBeGreaterThan(0);
    expect(restrictedErrors.some((m: Linter.LintMessage) => m.message.includes('Security boundary violation'))).toBe(true);
  });

  it('INV-1 / AC-7: apps/agent/package.json contains NO paypal dependencies', () => {
    const pkgPath = path.join(rootDir, 'apps/agent/package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

    const allDeps = {
      ...(pkg.dependencies || {}),
      ...(pkg.devDependencies || {}),
      ...(pkg.peerDependencies || {}),
    };

    const forbidden = Object.keys(allDeps).filter((dep) => dep.toLowerCase().includes('paypal'));
    expect(forbidden).toEqual([]);
  });

  it('INV-1: apps/agent/tsconfig.json does not reference packages/paypal', () => {
    const tsconfigPath = path.join(rootDir, 'apps/agent/tsconfig.json');
    const tsconfig = JSON.parse(fs.readFileSync(tsconfigPath, 'utf8'));
    const references = tsconfig.references || [];

    const hasPaypalRef = references.some((ref: { path: string }) =>
      ref.path.toLowerCase().includes('paypal'),
    );
    expect(hasPaypalRef).toBe(false);
  });

  it('Boundary check: apps/agent clean code passes linting without errors', async () => {
    const agentIndexPath = path.join(rootDir, 'apps/agent/src/index.ts');
    const results = await eslint.lintFiles([agentIndexPath]);

    const errorCount = results[0]?.errorCount ?? 0;
    expect(errorCount).toBe(0);
  });
});
