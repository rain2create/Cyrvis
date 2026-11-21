import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';
export default defineConfig({
  esbuild: { jsx: 'automatic' },
  plugins: [
    tsconfigPaths({
      projects: ['./tsconfig.node.json', './tsconfig.web.json'],
    }),
  ],
  test: {
    globals: true,
    environment: 'node',
    include: [
      'src/main/cyrvis/**/*.test.ts',
      'src/renderer/src/components/CyrvisGaze/*.test.ts',
      'src/shared/*.test.ts',
      'src/renderer/src/components/CyrvisVoice/*.test.ts',
    ],
    exclude: ['node_modules/**'],
  },
});
