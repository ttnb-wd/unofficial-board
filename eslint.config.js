import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'dist-vercel/**', 'node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: {
      globals: {
        console: 'readonly',
        process: 'readonly',
      },
    },
  },
  {
    files: ['scripts/*.mjs'],
    languageOptions: {
      globals: { process: 'readonly', URL: 'readonly' },
    },
  },
  {
    files: ['public/mini-app/**/*.js'],
    languageOptions: {
      globals: {
        AbortSignal: 'readonly',
        crypto: 'readonly',
        document: 'readonly',
        fetch: 'readonly',
        URLSearchParams: 'readonly',
        window: 'readonly',
      },
    },
  },
);
