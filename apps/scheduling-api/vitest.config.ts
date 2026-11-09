import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 20000,
    // Testes compartilham um Postgres real: rodar em série evita que o
    // truncate de um teste apague os dados de outro.
    fileParallelism: false,
  },
});
