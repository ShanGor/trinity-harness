import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
    environment: 'node',
    alias: {
      '@ant-design/x': fileURLToPath(
        new URL('./apps/web/node_modules/@ant-design/x/es/index.js', import.meta.url),
      ),
    },
    server: {
      deps: { inline: ['@ant-design/x', 'antd'] },
    },
    testTimeout: 20000,
    hookTimeout: 20000,
  },
});
