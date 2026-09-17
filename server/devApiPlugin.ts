import { loadEnv, type Plugin } from 'vite';

import { createJevClient, handleMood, type JevLike } from './moodHandler';

/**
 * `/api/mood` while running `vite dev`, standing in for the Vercel function.
 *
 * The body is read off the Node request by hand rather than with a body
 * parser: it is one small JSON object, and a dependency that only exists in
 * development is a dependency that can disagree with production.
 *
 * The TypeSafe key is read from the Vite env here, on the server side, and
 * handed to the client. It never enters the module graph the browser loads.
 */

/** The biggest body we will read, matching the Vercel function's limit. */
const MAX_BODY_BYTES = 2048;

export function devApiPlugin(): Plugin {
  return {
    name: 'jevj-dev-api',
    apply: 'serve',
    configureServer(server) {
      const env = loadEnv(server.config.mode, process.cwd(), '');
      const apiKey = env['TYPESAFE_API_KEY'] ?? '';
      let client: JevLike | null = null;

      server.middlewares.use('/api/mood', (req, res) => {
        const send = (status: number, json: unknown): void => {
          res.statusCode = status;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(json));
        };

        if (req.method !== 'POST') {
          res.setHeader('Allow', 'POST');
          send(405, { error: 'method not allowed' });
          return;
        }
        if (apiKey === '') {
          send(500, { error: 'mood service is not configured' });
          return;
        }

        let body = '';
        let aborted = false;
        req.on('data', (chunk: Buffer | string) => {
          if (aborted) return;
          body += chunk;
          if (body.length > MAX_BODY_BYTES) {
            aborted = true;
            send(413, { error: 'payload too large' });
            req.destroy();
          }
        });
        req.on('end', () => {
          if (aborted) return;
          let parsed: unknown;
          try {
            parsed = JSON.parse(body === '' ? 'null' : body);
          } catch {
            send(400, { error: 'body is not JSON' });
            return;
          }
          client ??= createJevClient(apiKey);
          void handleMood(parsed, { client }).then(
            (result) => send(result.status, result.json),
            // `handleMood` already turns a client failure into a 502; this is
            // the belt-and-braces case, and it says nothing either.
            () => send(502, { error: 'mood service unavailable' }),
          );
        });
      });
    },
  };
}
