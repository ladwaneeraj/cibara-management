// ESLint flat config — React + TypeScript SPA (frontend/).
//
// `tsc -b` (strict) is the undefined-variable / type gate for this app, so the
// value ESLint adds here is the React-specific correctness it can't see:
// rules-of-hooks violations and conditional hook calls (real runtime bugs).
// Stylistic rules are warnings so the gate stays about correctness; CI runs
// `eslint .` and fails on errors only.

import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist', 'coverage', 'node_modules', 'e2e/shots'] },
  {
    files: ['**/*.{ts,tsx}'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      globals: { ...globals.browser, ...globals.node },
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': [
        'warn',
        { allowConstantExport: true },
      ],
      // Signal, not blocker — legacy/iterating code has intentional cases.
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-empty-object-type': 'warn',
    },
  },
  {
    // Test files use vitest globals and looser typing.
    files: ['**/*.test.{ts,tsx}', 'src/test/**', 'e2e/**'],
    languageOptions: { globals: { ...globals.node } },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
    },
  },
);
