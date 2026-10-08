#!/usr/bin/env bash
set -euo pipefail

echo "=========================================================="
echo " MandatePay: Fresh Clone Validation (Task T-001 Verification)"
echo " PayPal AI Hackathon Submission"
echo "=========================================================="

echo "--> 1. Checking Node & Package Manager..."
node -v
if command -v pnpm &> /dev/null; then
  echo "pnpm is available: $(pnpm -v)"
else
  echo "pnpm not found globally, falling back to npx/corepack..."
fi

echo "--> 2. Validating Workspace Directory Structure..."
test -f package.json || { echo "Missing root package.json"; exit 1; }
test -f pnpm-workspace.yaml || { echo "Missing pnpm-workspace.yaml"; exit 1; }
test -f tsconfig.base.json || { echo "Missing tsconfig.base.json"; exit 1; }
test -f .eslintrc.cjs || { echo "Missing .eslintrc.cjs"; exit 1; }
test -f vitest.config.ts || { echo "Missing vitest.config.ts"; exit 1; }

# Apps check
test -f apps/api/package.json || { echo "Missing apps/api"; exit 1; }
test -f apps/agent/package.json || { echo "Missing apps/agent"; exit 1; }
test -f apps/stores/package.json || { echo "Missing apps/stores"; exit 1; }
test -f apps/web/package.json || { echo "Missing apps/web"; exit 1; }

# Packages check
test -f packages/schemas/package.json || { echo "Missing packages/schemas"; exit 1; }
test -f packages/policy/package.json || { echo "Missing packages/policy"; exit 1; }
test -f packages/audit/package.json || { echo "Missing packages/audit"; exit 1; }
test -f packages/scanner/package.json || { echo "Missing packages/scanner"; exit 1; }
test -f packages/paypal/package.json || { echo "Missing packages/paypal"; exit 1; }
test -f packages/sim/package.json || { echo "Missing packages/sim"; exit 1; }

echo "--> 3. Checking Boundary Isolation Rule..."
# Verify apps/agent package.json does NOT contain paypal dependency
if grep -q "paypal" apps/agent/package.json; then
  echo "FAIL: apps/agent must NEVER declare paypal dependencies!"
  exit 1
fi
echo "PASS: apps/agent has zero paypal dependencies."

echo "--> 4. Running Vitest Test Suite..."
npx vitest run

echo "=========================================================="
echo " SUCCESS: MandatePay repository bootstrap validated!"
echo "=========================================================="
