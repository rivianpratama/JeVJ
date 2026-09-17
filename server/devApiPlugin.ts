import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { loadEnv, type Plugin } from 'vite';

import { createJevClient } from './moodHandler';
import { createRoutes } from './routes';
import { JobRunner } from './ytdlp/job';
import { nodeSpawner } from './ytdlp/spawn';

/**
 * The whole API while running `vite dev`, which is the same router `npm start`
 * serves.
 *
 * Mounting `createRoutes` rather than one handler is the point: a route that
 * works in development works after `npm run build` because it is the same
 * object, and the only thing this file adds is where the environment and the
 * cache directory come from.
 *
 * The TypeSafe key is read from the Vite env here, on the server side. It
 * never enters the module graph the browser loads.
 */
export function devApiPlugin(): Plugin {
  return {
    name: 'jevj-dev-api',
    apply: 'serve',
    configureServer(server) {
      const env = loadEnv(server.config.mode, process.cwd(), '');
      const apiKey = env['TYPESAFE_API_KEY'] ?? '';
      const cacheDir = join(process.cwd(), 'cache');
      mkdirSync(cacheDir, { recursive: true });

      const router = createRoutes({
        jev: apiKey === '' ? null : createJevClient(apiKey),
        jobs: new JobRunner(cacheDir, nodeSpawner(), env['YT_DLP'] ?? 'yt-dlp'),
        cacheDir,
      });

      server.middlewares.use((req, res, next) => {
        router.handle(req, res, next);
      });
    },
  };
}
