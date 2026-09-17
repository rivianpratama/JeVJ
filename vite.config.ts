import { defineConfig } from 'vite';
import { devApiPlugin } from './server/devApiPlugin.ts';

export default defineConfig({
  plugins: [devApiPlugin()],
  server: { port: 5173 },
});
