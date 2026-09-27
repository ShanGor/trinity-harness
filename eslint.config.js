import js from '@eslint/js';
import importPlugin from 'eslint-plugin-import';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**', 'ref/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx'],
    plugins: { import: importPlugin },
    settings: {
      'import/resolver': {
        typescript: {
          alwaysTryTypes: true,
          project: ['./packages/*/tsconfig.json', './apps/*/tsconfig.json'],
        },
      },
    },
    rules: {
      // Dependency-direction gate (AGENTS.md §3): packages/contracts must stay
      // dependency-free; new implementation packages must be registered here.
      'import/no-restricted-paths': [
        'error',
        {
          zones: [
            {
              // packages/contracts must not import implementation packages.
              target: './packages/contracts',
              from: './packages/db',
              message: 'contracts must not import implementation packages (AGENTS.md §3.1)',
            },
            {
              target: './packages/contracts',
              from: './packages/shared',
              message: 'contracts must not import implementation packages (AGENTS.md §3.1)',
            },
          ],
        },
      ],
      'import/no-cycle': ['error', { maxDepth: 5 }],
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/no-empty-object-type': 'off',
    },
  },
  {
    files: ['**/*.test.ts', '**/*.test.tsx'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
);
