// Starter ESLint (flat config) cho Next.js. Cần devDependencies:
//   eslint eslint-config-next typescript-eslint
// Với Vite/React thuần: thay "next/core-web-vitals" bằng eslint-plugin-react-hooks + typescript-eslint.
import next from 'eslint-config-next/core-web-vitals';
import tseslint from 'typescript-eslint';

export default [
  ...next,
  ...tseslint.configs.recommended,
  {
    rules: {
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'react/no-danger': 'warn',
    },
  },
  { ignores: ['.next/**', 'dist/**', 'coverage/**', '**/*.generated.*', 'next-env.d.ts'] },
];
