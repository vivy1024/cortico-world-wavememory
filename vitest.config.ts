import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const FRAMEWORK_SRC = fileURLToPath(new URL('../Cortico/src/', import.meta.url));

export default defineConfig({
  resolve: {
    alias: [{ find: /^cortico\//, replacement: FRAMEWORK_SRC }],
  },
  server: {
    fs: { allow: [fileURLToPath(new URL('./', import.meta.url)), FRAMEWORK_SRC] },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    env: { CORTICO_LANGUAGE: 'zh' },
    testTimeout: 20000,
    pool: 'forks',
  },
});
