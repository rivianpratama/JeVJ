import { loadEnv, type Plugin } from 'vite';

/**
 * Dev-only middleware that backs `/api/mood` while running `vite dev`.
 *
 * The TypeSafe key is read from the Vite env here, on the server side, so it is
 * never bundled into client code. Task 7 replaces the 501 stub with the real
 * Jev call; until then the route exists so the client can be wired against it.
 */
export function devApiPlugin(): Plugin {
  return {
    name: 'jevj-dev-api',
    apply: 'serve',
    configureServer(server) {
      const env = loadEnv(server.config.mode, process.cwd(), '');
      const apiKey = env.TYPESAFE_API_KEY ?? '';
      void apiKey; // consumed in Task 7

      server.middlewares.use('/api/mood', (_req, res) => {
        res.statusCode = 501;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'not implemented' }));
      });
    },
  };
}
