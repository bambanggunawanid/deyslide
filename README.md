# Deyslide

A hybrid presentation engine for two kinds of talks:

- **Live Teaching Mode**: workshops, live coding, flexible Q&A pacing, readable text and speaker tools.
- **Cinematic Presentation Mode**: conference keynotes, recorded videos, deep zoom 3D scenes and frame accurate algorithm animations.

Built on [Slidev](https://sli.dev) (Vue 3, Vite, UnoCSS, Shiki Magic Move), [TresJS](https://tresjs.org) for 3D, and [Motion Canvas](https://motioncanvas.io) for procedural 2D animation.

The hosted app at https://deyslide.bambanggunawan.id opens on a projects home page. A project holds decks, like a file in Figma. The demo deck plays at [/demo/](https://deyslide.bambanggunawan.id/demo/).

## Quick start

```bash
pnpm install
pnpm dev       # the demo deck in Slidev
pnpm dev:web   # the web app with the projects home page
pnpm dev:server  # the API, for accounts and cloud save (needs Postgres, see "API server")
```

Open the printed URL. In the deck, press `o` for the slide overview and `p` for presenter mode.

## Scripts

| Command | Output |
| --- | --- |
| `pnpm dev` | Deck development server with HMR |
| `pnpm dev:web` | Web app development server with HMR |
| `pnpm dev:server` | API server, restarted on every change |
| `pnpm build` | Deck in `apps/deck/dist/` (served under `/demo/`), web app in `apps/web/dist/`, API in `apps/server/dist/server.mjs` |
| `pnpm export` | PDF handout in `exports/deyslide.pdf` |
| `pnpm export:video` | WebM video in `exports/deyslide.webm` |
| `pnpm test` | BDD scenarios in `features/` |
| `pnpm test:e2e` | End to end tests in a real browser, local only (see "End to end tests") |
| `pnpm typecheck` | Type check for the web app, the API, the deck and the animations |

Each deck script, and `pnpm build`, first runs `pnpm animations:build`, which compiles the Motion Canvas projects into `apps/deck/public/animations/`.

`pnpm export` and `pnpm export:video` need Chromium. Install it once with `pnpm exec playwright install chromium`.

### Video export options

```bash
pnpm export:video --output exports/talk.webm --width 1920 --height 1080 --dwell 3000
```

`--dwell` is how long each click step stays on screen, in milliseconds. A slide can ask for more time in its frontmatter:

```yaml
---
videoDwell: 12 # seconds per click step on this slide
---
```

## Components

The components live in `packages/components`, a Slidev addon. The deck lists it under `slidev.addons` in `apps/deck/package.json`, so Slidev auto imports every component in `packages/components/components/`.

### `<DeyslideScene3D>`

A TresJS viewport with a placeholder system architecture, three point lighting and a smooth camera.

```html
<DeyslideScene3D
  scene-id="architecture"
  :camera-position="[8, 6, -7]"
  :focus="['gateway', 'orders', 'database'][$clicks]"
  :zoom-level="1.5"
/>
```

| Prop | Default | Description |
| --- | --- | --- |
| `cameraPosition` | `[7, 5, 9]` | Camera position before zoom |
| `target` | origin | Look at point when `focus` is not set |
| `focus` | none | Architecture node to center and highlight: `client`, `gateway`, `auth`, `orders`, `search`, `database`, `cache` |
| `zoomLevel` | `1` | `2` halves the distance to the target, `0.5` doubles it |
| `orbitControls` | `false` | Mount OrbitControls. Off for recordings, on for live Q&A |
| `model` | none | GLTF or GLB path that replaces the placeholder |
| `sceneId` | `default` | Viewports with the same id share camera memory, so the camera glides across slides |
| `smoothing` | `3` | Camera easing speed. `0` jumps |
| `spin` | `0` | Radians per second the placeholder turns |
| `transparent` | `false` | Let the slide background show through |

The camera animates only on the slide the audience sees. Preloaded slides hold still, and overview, next slide previews and PDF export jump straight to the final pose.

### `<DeyslideAlgoPlayer>`

A wrapper around `<motion-canvas-player>` with play, pause, restart and loop controls.

```html
<DeyslideAlgoPlayer src="/animations/bubble-sort.js" />
```

| Prop | Default | Description |
| --- | --- | --- |
| `src` | required | Built Motion Canvas project. Root paths resolve under the deck base URL |
| `autoplay` | `true` | Play when the slide becomes active, pause when it is left |
| `loop` | `true` | Start over at the end |
| `controls` | `true` | Show the control bar |
| `quality` | player default | Rendering quality from 0 to 1 |
| `variables` | none | Project variables |

To add an animation, create a project in `packages/animations/src/`, add it to the `project` list in `packages/animations/vite.config.ts`, and give its `.meta` file a `name`. The bundle appears at `/animations/<name>.js`.

### `<DeyslideLiveSandbox>`

A live state inspector for workshops. Booleans become switches, numbers get steppers and strings get inputs. It shows the state as JSON, keeps a short change log, and supports undo and reset. The default slot receives the live state.

```html
<DeyslideLiveSandbox :initial="{ orbitControls: false, zoom: 1 }" :step="0.5">
  <template #default="{ state }">
    <DeyslideScene3D :orbit-controls="state.orbitControls" :zoom-level="state.zoom" />
  </template>
</DeyslideLiveSandbox>
```

## Web app

`apps/web` is a Vue 3 and Vite single page app. It is the start of the cloud editor planned in issue #8.

| Page | Path |
| --- | --- |
| Projects home page | `/` |
| A project and its decks | `/p/<project id>` |
| A deck: Markdown editor with a live slide preview | `/p/<project id>/d/<deck id>` |
| Sign in, sign up, forgot and reset password | `/sign-in`, `/sign-up`, `/forgot-password`, `/reset-password` |
| The demo deck, a separate Slidev build | `/demo/` |

Anyone can start right away, with no account. As a guest, the project list is kept in IndexedDB and every deck is a Yjs document stored with `y-indexeddb`, so work survives a reload but stays in that browser. A banner says so.

Signed in, projects and decks live in the account and open on any device. Signing in moves the browser's projects into the account, keeping their ids so old links still work, and then clears them from the browser. If the move fails, they stay in the browser and the move is tried again at the next sign in.

The pages talk to one `ProjectStore` interface (`apps/web/src/projects/`): `GuestStore` for the browser and `CloudStore` for the account. `startSession` picks the right one at startup, and `Workspace` switches it on sign in and sign out.

The sign in page offers only what the API reports as configured at `/api/config`, so a missing Google app hides the Google button instead of breaking it.

### Editor and slide preview

A deck opens in a Markdown editor (CodeMirror) beside a preview of the slide under the cursor. Slide buttons move both, and a click stepper plays `v-click`, `v-clicks` and Magic Move steps. On phones, tabs switch between writing and the preview. Changes save on their own a moment after typing stops, to the browser or the account, and the editor says whether they are saved.

The preview renders Slidev Markdown the way Slidev does, in the browser (`apps/web/src/preview/`):

1. The slide is split on `::name::` lines into slots, and each part goes through markdown-it with Vue components allowed, as in Slidev. Code is highlighted with Shiki and wrapped in `v-pre`, so it is shown and never evaluated.
2. The result is compiled as a Vue template on the fly, inside the slide's layout. Slidev's own layouts and the default theme's styles are used, and UnoCSS generates utility classes as slides use them.
3. Deyslide components (3D scene, algorithm player, live sandbox, shape) load when a slide uses them.

A deck can run code, and decks will be shared, so the preview is its own page (`preview.html`) in an iframe with `sandbox="allow-scripts"`. It has an opaque origin: no access to the app, its storage, its cookies or the API. The editor talks to it with `postMessage`. Because of that origin, the preview's scripts load as cross origin requests, which is why nginx and Vite allow any origin on static assets.

## API server

`apps/server` is a Node 24 server with [Hono](https://hono.dev) and [Better Auth](https://www.better-auth.com), on Postgres through [Kysely](https://kysely.dev). nginx serves it under `/api/`, on the same origin as the web app, so auth cookies stay first party.

| Sign in option | Needs |
| --- | --- |
| Email and password, with email confirmation and password reset | Email sending |
| Magic link | Email sending |
| Google | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` |
| GitHub | `GH_OAUTH_CLIENT_ID`, `GH_OAUTH_CLIENT_SECRET` |

Email goes through the [Cloudflare Email Service REST API](https://developers.cloudflare.com/email-service/api/send-emails/rest-api/) with `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_EMAIL_TOKEN`, from `EMAIL_FROM` (default `noreply@bambanggunawan.id`). Without them, production turns email sign in off, and development prints every email, links included, to the terminal.

The server creates and updates its tables on every start. For local development, run Postgres and give the server its connection in `apps/server/.env` (ignored by git):

```bash
podman run -d --name deyslide-pg -p 5432:5432 \
  -e POSTGRES_USER=deyslide -e POSTGRES_PASSWORD=deyslide -e POSTGRES_DB=deyslide \
  docker.io/library/postgres:18-alpine

printf 'PGHOST=127.0.0.1\nPGUSER=deyslide\nPGPASSWORD=deyslide\nPGDATABASE=deyslide\n' > apps/server/.env
pnpm dev:server   # http://127.0.0.1:3001, which pnpm dev:web proxies under /api/
```

| Variable | Default | Purpose |
| --- | --- | --- |
| `PUBLIC_URL` | `http://localhost:5173` | The address people open. Links in emails and OAuth callbacks use it |
| `BETTER_AUTH_SECRET` | a development value | Signs sessions. Required in production, at least 32 characters |
| `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE` | Postgres defaults | Database connection |
| `HOST`, `PORT` | `127.0.0.1`, `3001` | Where the API listens |

| Endpoint | Purpose |
| --- | --- |
| `GET /api/projects` | The signed in person's projects with their decks |
| `POST /api/projects`, `PATCH` and `DELETE /api/projects/:id` | Create, rename, delete a project |
| `POST /api/projects/:id/decks` | Add a deck: a name and the deck's Yjs document in base64 |
| `PATCH` and `DELETE /api/decks/:id` | Rename, delete a deck |
| `GET /api/decks/:id/state` | The deck's Yjs document, as binary |
| `POST /api/import` | Move browser projects into the account. Running it twice adds nothing |

Every deck written is checked with `@deyslide/deck-model` before it is saved, and at most 5 MB is accepted. Anything the person does not own reads as not found.

The BDD scenarios run the whole API on [PGlite](https://pglite.dev), Postgres compiled to WebAssembly, so `pnpm test` needs no database.

A new deck starts from one of two templates: **Blank** (one title slide) or **Demo deck** (`apps/deck/slides.md`, read with `fromMarkdown`).

## End to end tests

`pnpm test:e2e` runs `e2e/*.e2e.ts` with Playwright in headless Chromium, on a desktop and a phone screen. It starts everything it needs:

- the API from `apps/server` on [PGlite](https://pglite.dev), so no database is needed, with sent emails kept in memory so tests can open confirmation, magic link and reset links (`e2e/server.ts`, never deployed)
- the production build of the web app with `vite preview`, sending `/api` to that API

It covers guest projects and decks, sign up, sign in, magic link, password reset, sign out, and browser projects moving into the account and opening on a second browser. It is not part of CI.

Install Chromium once with `pnpm exec playwright install chromium`. To use a Chromium you already have instead, set `PLAYWRIGHT_CHROMIUM_PATH` to its executable. After a failure, `pnpm exec playwright show-trace test-results/<test>/trace.zip` replays it step by step.

## Deck format

`packages/deck-model` defines the deck that the upcoming cloud editor saves and syncs (see the epic in issue #8).

- `DeckSchema` (Zod) validates a deck: slides with Slidev frontmatter, speaker notes, and elements. Element types are `text`, `image`, `shape`, `code` (one step, or several for a Magic Move), `scene3d`, `algo-player`, `sandbox`, and `raw` for Markdown the model does not understand.
- `toMarkdown(deck)` writes Slidev Markdown. Positioned elements use Slidev's own `<v-drag pos="x,y,w,h,rotate">` in Slidev canvas units (980 by 551.25), so plain Slidev renders the output. Slide ids live in frontmatter as `id`, element ids as `data-id`.
- `fromMarkdown(markdown)` reads it back. Anything it cannot represent exactly, including a `v-drag` block with a JavaScript expression, is kept byte for byte as a `raw` element.
- `deckToYDoc(deck)` and `yDocToDeck(doc)` map the deck to a Yjs document. Positions are per field and text is `Y.Text`, so concurrent moves and typing merge.

## Deployment

Every push to `main` runs `.github/workflows/deploy.yml`, which publishes the web app to https://deyslide.bambanggunawan.id, the demo deck to https://deyslide.bambanggunawan.id/demo/ and the API under https://deyslide.bambanggunawan.id/api/.

1. Builds the web app, the deck and the API bundle, and runs the BDD scenarios.
2. Joins the tailnet as `tag:ci` through the Tailscale OAuth client.
3. Uploads the release and the API settings to `~/deyslide` on the server over Tailscale SSH, as user `ryzen`.
4. Runs `deploy/up.sh`, which starts a Podman pod named `deyslide` with four containers:

   | Container | Image | Role |
   | --- | --- | --- |
   | `deyslide-db` | `postgres:18-alpine` | Database, data in the `deyslide-pgdata` volume. Kept running across deploys |
   | `deyslide-server` | `node:24-alpine` | The API on port 3001, running the bundled `server.mjs` |
   | `deyslide-app` | `nginx:stable-alpine` | Port 3000: web app, demo deck, and `/api/` passed to the API |
   | `deyslide-tunnel` | `cloudflared` | Publishes `app:3000` through the Cloudflare tunnel |

5. Checks that nginx answers at `/`, `/demo/` and `/api/health`, the tunnel connects, and the public URL serves all three.

The pod has its own network and publishes no port, so ports 3000, 3001 and 5432 on the server stay free. Inside the pod, `app` points at the pod's loopback, which is how the Cloudflare tunnel route `http://app:3000` reaches nginx.

On its first run, `up.sh` creates `~/deyslide/secrets.env` with a random database password and auth secret. They never leave the server and are kept on later deploys, since a new auth secret would sign everyone out.

The `Production` environment holds:

| Name | Kind | Needed for |
| --- | --- | --- |
| `TAILSCALE_CLIENT_ID`, `TAILSCALE_CLIENT_KEY` | Secrets | Reaching the server |
| `CLOUDFLARE_TUNNEL_TOKEN` | Secret | Publishing the site |
| `TAILSCALE_SERVER_IP` | Variable | Reaching the server |
| `CLOUDFLARE_ACCOUNT_ID` | Variable | Email sign in (optional) |
| `CLOUDFLARE_EMAIL_TOKEN` | Secret | Email sign in (optional), a token with Email Sending: Edit |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Secrets | Google sign in (optional) |
| `GH_OAUTH_CLIENT_ID`, `GH_OAUTH_CLIENT_SECRET` | Secrets | GitHub sign in (optional). GitHub reserves the `GITHUB_` prefix |

OAuth apps use these callback URLs: `https://deyslide.bambanggunawan.id/api/auth/callback/google` and `https://deyslide.bambanggunawan.id/api/auth/callback/github`.

The server needs Tailscale SSH (`tailscale up --ssh`) and Podman for `ryzen`. The tailnet policy must let `tag:ci` open SSH to `tag:server` as `ryzen`. To start the containers again after a reboot, run once on the server:

```bash
sudo loginctl enable-linger ryzen
systemctl --user enable podman-restart.service
```

A manual deploy can be started from the Actions tab with **Run workflow** on the Deploy workflow.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md). Every change starts with an issue, and every behavior starts with a Gherkin scenario.

## License

[MIT](LICENSE)
