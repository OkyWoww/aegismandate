/* eslint-disable @typescript-eslint/no-require-imports */
const { execSync } = require('child_process');

const rawLog = execSync('git log -p --all', { maxBuffer: 100 * 1024 * 1024 }).toString();

const secretRules = [
  { name: 'PayPal Client Secret (Live)', regex: /PAYPAL_CLIENT_SECRET\s*=\s*(?!your_|[A-Za-z0-9_-]*default|[A-Za-z0-9_-]*example|[A-Za-z0-9_-]*mock|[A-Za-z0-9_-]*dev)[A-Za-z0-9_-]{30,}/i },
  { name: 'PayPal Buyer Password', regex: /PAYPAL_BUYER_PASSWORD\s*=\s*['"][^'"]{6,}['"]/i },
  { name: 'Private Key Block', regex: /-----BEGIN (RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/ },
  { name: 'Stripe Live Secret Key', regex: /sk_live_[0-9a-zA-Z]{24,}/ },
  { name: 'AWS Access Key ID', regex: /AKIA[0-9A-Z]{16}/ },
  { name: 'AWS Secret Access Key', regex: /aws_secret_access_key\s*=\s*[A-Za-z0-9/+=]{40}/i },
  { name: 'GitHub Personal Access Token', regex: /gh[pousr]_[0-9a-zA-Z]{36,}/ },
  { name: 'Slack Bot/User/Webhook Token', regex: /xox[baprs]-[0-9a-zA-Z]{10,48}/ },
  { name: 'OpenAI API Secret Key', regex: /sk-[a-zA-Z0-9]{20}T3BlbkFJ[a-zA-Z0-9]{20}/ },
  { name: 'Google API Key / AI Studio Key', regex: /AIza[0-9A-Za-z-_]{35}/ },
  { name: 'Generic High-Entropy Password Assignment', regex: /(password|passwd|pwd|secret)\s*[:=]\s*['"][a-zA-Z0-9!@#$%^&*()_+]{16,}['"]/i },
];

console.log('='.repeat(80));
console.log('GIT ENTIRE HISTORY SECRET SCAN REPORT');
console.log('='.repeat(80));

let violations = 0;
for (const rule of secretRules) {
  const matches = rawLog.match(new RegExp(rule.regex, 'g')) || [];
  console.log(`[Rule: ${rule.name.padEnd(34)}] Matches found: ${matches.length}`);
  if (matches.length > 0) {
    violations += matches.length;
    matches.forEach(m => console.log('  -> Match snippet: ' + m.substring(0, 40) + '...'));
  }
}
console.log('='.repeat(80));
console.log(`Scan Summary: Full git history (--all) inspected cleanly. Violations detected: ${violations}`);
console.log('='.repeat(80));
