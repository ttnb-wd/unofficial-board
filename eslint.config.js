import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**'] },
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
    files: ['public/mini-app/**/*.js'],
    languageOptions: {
      globals: {
        crypto: 'readonly',
        document: 'readonly',
        fetch: 'readonly',
        URLSearchParams: 'readonly',
        window: 'readonly',
      },
    },
  },
);
