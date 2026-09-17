# JeVJ

JeVJ is a browser audio visualizer: it listens to what is playing, describes the
music to [TypeSafe](https://typesafe.ai)'s Jev model as a compact typed
snapshot — tempo, key, dynamics, spectral shape, build cues — and turns the
judgment that comes back (valence, arousal, genre, section, whether a drop is
about to land) into three.js visuals that move with the track.

## Run it

```sh
cp .env.example .env   # then put your TypeSafe key in TYPESAFE_API_KEY
npm install
npm run dev            # http://localhost:5173
```

The key is read server-side by the dev middleware and by the Vercel function; it
never reaches the client bundle. Chrome is required — the audio path relies on
Chrome's Web Audio and tab-capture behaviour and is not supported elsewhere.

`npm test` runs the unit suite (vitest, Node environment); `npm run build`
type-checks and builds.

## Deploy

Deploys to Vercel as a Vite app with serverless functions under `api/`. Set
`TYPESAFE_API_KEY` in the Vercel project's environment variables — there is no
client-side fallback.
