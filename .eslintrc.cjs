/** @type {import('eslint').Linter.Config} */
module.exports = {
  root: true,
  env: {
    node: true,
    es2022: true,
  },
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
  },
  plugins: ['@typescript-eslint'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
  ],
  rules: {
    '@typescript-eslint/no-explicit-any': 'error',
    '@typescript-eslint/no-unused-vars': [
      'warn',
      { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
    ],
  },
  overrides: [
    {
      files: ['apps/agent/**/*.{ts,tsx,js,jsx}'],
      rules: {
        'no-restricted-imports': [
          'error',
          {
            paths: [
              {
                name: 'packages/paypal',
                message: 'Security boundary violation: apps/agent must never import packages/paypal.',
              },
              {
                name: '@mandatepay/paypal',
                message: 'Security boundary violation: apps/agent must never import packages/paypal.',
              },
              {
                name: '@paypal/checkout-server-sdk',
                message: 'Security boundary violation: apps/agent must never import PayPal SDKs.',
              },
              {
                name: 'paypal-rest-sdk',
                message: 'Security boundary violation: apps/agent must never import PayPal SDKs.',
              },
            ],
            patterns: [
              {
                group: [
                  '**/packages/paypal/**',
                  '**/packages/paypal',
                  '@mandatepay/paypal/**',
                  '@mandatepay/paypal',
                  '@paypal/**',
                  'paypal-*',
                ],
                message: 'Security boundary violation: apps/agent must never import PayPal packages or SDKs.',
              },
            ],
          },
        ],
      },
    },
    {
      files: ['packages/policy/**/*.{ts,tsx}'],
      rules: {
        'no-console': 'error',
      },
    },
  ],
  ignorePatterns: [
    'node_modules/',
    'dist/',
    'build/',
    'coverage/',
    '*.db*',
  ],
};
