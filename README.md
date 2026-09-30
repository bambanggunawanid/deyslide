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
pnpm dev:renderer  # slide images for the MCP server (after pnpm build, see "Claude Code")
```

Open the printed URL. In the deck, press `o` for the slide overview and `p` for presenter mode.

## Scripts

| Command | Output |
| --- | --- |
| `pnpm dev` | Deck development server with HMR |
| `pnpm dev:web` | Web app development server with HMR |
| `pnpm dev:server` | API server, restarted on every change |
| `pnpm dev:renderer` | Slide renderer for the MCP server, serving `apps/web/dist/` |
| `pnpm build` | Deck in `apps/deck/dist/` (served under `/demo/`), web app in `apps/web/dist/`, API in `apps/server/dist/server.mjs`, renderer in `apps/renderer/dist/renderer.mjs` |
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

### Sharing

Signed in people share a project, or a single deck, from its **Share** button, by email:

| Role | Can |
| --- | --- |
| Owner | Everything: share, change roles, remove people, delete |
| Editor | Open, edit, rename, add decks to a shared project, and share with others |
| Viewer | Open and read. The deck page says "View only" and nothing is saved |

- A deck's role is the higher of its own and its project's, so a viewer of a project can be an editor of one deck in it.
- Only the owner changes roles and removes people. Anyone else can leave.
- Someone with an account gets a "shared with you" email and finds the work under **Shared with you** on the home page. An address without an account gets an invite, which turns into access when someone signs up with that address and confirms it.
- The deck assistant and the MCP server follow the same roles: viewers can read a deck, not change it.
- Deleting a project or deck ends its sharing and cancels its invites. Each project or deck holds at most 50 people and invites.

The pages talk to one `ProjectStore` interface (`apps/web/src/projects/`): `GuestStore` for the browser and `CloudStore` for the account. `startSession` picks the right one at startup, and `Workspace` switches it on sign in and sign out.

The sign in page offers only what the API reports as configured at `/api/config`, so a missing Google app hides the Google button instead of breaking it.

### Editor and slide preview

A deck opens in a Markdown editor (CodeMirror) beside a preview of the slide under the cursor. Slide buttons move both, and a click stepper plays `v-click`, `v-clicks` and Magic Move steps. On phones, tabs switch between writing and the preview. Changes save on their own a moment after typing stops, to the browser or the account, and the editor says whether they are saved.

The preview renders Slidev Markdown the way Slidev does, in the browser (`apps/web/src/preview/`):

1. The slide is split on `::name::` lines into slots, and each part goes through markdown-it with Vue components allowed, as in Slidev. Code is highlighted with Shiki and wrapped in `v-pre`, so it is shown and never evaluated.
2. The result is compiled as a Vue template on the fly, inside the slide's layout. Slidev's own layouts and the default theme's styles are used, and UnoCSS generates utility classes as slides use them.
3. Deyslide components (3D scene, algorithm player, live sandbox, shape) load when a slide uses them.

A deck can run code, and decks will be shared, so the preview is its own page (`preview.html`) in an iframe with `sandbox="allow-scripts"`. It has an opaque origin: no access to the app, its storage, its cookies or the API. The editor talks to it with `postMessage`. Because of that origin, the preview's scripts load as cross origin requests, which is why nginx and Vite allow any origin on static assets.

### Deck assistant

Signed in people can ask Claude to change the open deck from a chat under the preview: "Add a slide that compares bubble sort and merge sort", "Reveal the points on slide 3 one click at a time". Each change lands in the editor as Claude makes it, the preview jumps to the changed slide, and autosave keeps it like a typed change. The editor is read only while Claude works, and **Undo** takes back the whole reply. Guests see a link to sign in.

The browser sends the deck's Markdown and the chat with each message (`apps/web/src/assistant/`). On the server (`apps/server/src/assistant/`), Claude gets that Markdown with numbered slides and four tools: `replace_slide`, `insert_slide`, `delete_slide` and `move_slide`. The tools change a copy of the Markdown in memory, and a change that would split a slide in two, break its frontmatter YAML or make an unreadable deck goes back to Claude as an error instead. Claude has no tool that reads the database or any other deck, and a request for a deck the person does not own is refused before Claude sees anything.

## Media uploads

Every project has a media library: images, video and audio for its slides. Files are private, in a private Cloudflare R2 bucket under `projects/<project id>/`, and there is no public address for them. The editor starts using this in phase 4; for now it is an API.

- Everyone the project is shared with can see and open its files. Editors add files, and only the owner deletes them. Someone given a single deck can open only the files that deck's slides use through `/api/media/<id>/file`.
- Each account has 1 GB (`MEDIA_ACCOUNT_LIMIT_MB`) for the files in all the projects it owns. A file an editor adds counts toward the project owner's storage.
- Accepted: PNG, JPEG, GIF, WebP, AVIF, MP4, WebM, MOV, MP3, M4A, OGG and WAV, up to 100 MB each. SVG is refused, since it can carry scripts.
- Uploads go straight from the browser to R2 with a signed link that works for 15 minutes and only for the declared type and size, so large files never pass through the API or the tunnel.
- Finishing an upload checks the stored size and the file's first bytes against its type. A file that is not what it claims is deleted.
- Downloads use signed links that also work for 15 minutes, so removing someone from a project soon ends their access. `GET /api/media/:id/file` redirects to a fresh one, so slides can use a stable address.
- Deleting a project deletes its files. Uploads never finished are cleaned up after a day.

The browser talks to R2 directly, so the bucket needs a CORS policy. In the Cloudflare dashboard, open the bucket, then **Settings**, **CORS policy**, and add:

```json
[
  {
    "AllowedOrigins": ["https://deyslide.bambanggunawan.id"],
    "AllowedMethods": ["PUT", "GET", "HEAD"],
    "AllowedHeaders": ["content-type"],
    "MaxAgeSeconds": 3600
  }
]
```

For local development, add `http://localhost:5173` to `AllowedOrigins`.

## Claude Code

People who use [Claude Code](https://claude.com/claude-code) can build and edit their Deyslide decks from it, with their own Claude plan: no API key and nothing to buy on Deyslide. Install the plugin, which brings the MCP server and a skill on writing good decks:

```text
/plugin marketplace add bambanggunawanid/deyslide
/plugin install deyslide@deyslide
```

Or add only the MCP server:

```bash
claude mcp add --transport http deyslide https://deyslide.bambanggunawan.id/mcp
```

The first tool call opens the browser: sign in to Deyslide and allow the app. Claude Code then works on that account's decks, and `/mcp` signs in again when needed.

| Tool | What it does |
| --- | --- |
| `get_guide` | The writing guide: workflow, Slidev syntax, layouts, clicks, Magic Move, Deyslide components, design rules |
| `list_decks` | Projects and decks, with ids, slide counts and editor links |
| `create_project`, `create_deck` | New projects, and decks from Markdown |
| `read_deck` | A deck's Markdown with each slide numbered |
| `write_deck` | Replaces a whole deck |
| `edit_slides` | Replace, insert, delete and move slides in one batch that saves all edits or none |
| `render_slides` | PNG images of up to six slides, with each slide's click count, overflow and render errors |

Everything is checked the way the web app checks it, and every call reaches only the signed in person's decks. There are no delete tools. A deck open in the browser picks up changes made from Claude Code when its tab comes back into view, unless it has unsaved typing.

How it fits together:

- **Sign in** (`apps/server/src/auth.ts`): Better Auth's [OAuth provider](https://www.better-auth.com/docs/plugins/oauth-provider) with dynamic client registration and PKCE. MCP clients register themselves with a loopback redirect, so they are registered as native apps. Access tokens are JWTs whose audience is the MCP endpoint, valid for an hour and refreshed by the client. The consent page is `apps/web/src/pages/ConsentPage.vue`.
- **Discovery**: `/.well-known/oauth-protected-resource/mcp` names the authorization server, and `/.well-known/oauth-authorization-server/api/auth` describes it. A call without a valid token gets 401 with a `WWW-Authenticate` header that points to the first.
- **MCP server** (`apps/server/src/mcp/`): Streamable HTTP at `/mcp`, stateless, with one server per request bound to the token's account.
- **Renderer** (`apps/renderer/`): draws slides with the web app's own preview in headless Chromium, so images match the editor. Each request gets a fresh browser context that can only load the web app's files; in production the container also has no network, and the API reaches it through a Unix socket. It checks whether anything is drawn past the slide's edges to report overflow.
- **Plugin** (`.claude-plugin/marketplace.json`, `plugins/deyslide/`): the MCP server settings and the `deyslide` skill.

To try it locally, run `pnpm build`, then `pnpm dev:server` with `RENDERER_URL=http://127.0.0.1:3102` in `apps/server/.env`, `pnpm dev:renderer` and `pnpm dev:web`, and add `http://localhost:5173/mcp` to Claude Code. The renderer uses Playwright's Chromium, or the one in `CHROMIUM_PATH`.

## API server

`apps/server` is a Node 24 server with [Hono](https://hono.dev) and [Better Auth](https://www.better-auth.com), on Postgres through [Kysely](https://kysely.dev). nginx serves it under `/api/`, on the same origin as the web app, so auth cookies stay first party.

| Sign in option | Needs |
| --- | --- |
| Email and password, with email confirmation and password reset | Email sending |
| Magic link | Email sending |
| Google | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` |
| GitHub | `GH_OAUTH_CLIENT_ID`, `GH_OAUTH_CLIENT_SECRET` |

Email goes through the [Cloudflare Email Service REST API](https://developers.cloudflare.com/email-service/api/send-emails/rest-api/) with `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_EMAIL_TOKEN`, from `EMAIL_FROM` (default `noreply@bambanggunawan.id`). Without them, production turns email sign in off, and development prints every email, links included, to the terminal.

The deck assistant needs `ANTHROPIC_API_KEY`, a [Claude API](https://platform.claude.com) key that Deyslide pays for. It uses Claude Opus 5.5 (`claude-opus-5-5`) with server side refusal fallbacks turned on (`fallbacks: "default"`): if Claude declines a request for policy reasons, the API retries it on the fallback model Anthropic recommends, and that model's tokens count at its own price. Each account may spend `ASSISTANT_MONTHLY_LIMIT_USD` (default 3) US dollars per calendar month (UTC), counted from the token usage the API reports, and runs one request at a time. For local testing without a key, sign in with the [`ant` CLI](https://github.com/anthropics/anthropic-cli) (`ant auth login`, billed to your Claude Console organization), set `ASSISTANT_ENABLED=true` and leave `ANTHROPIC_API_KEY` unset, since any value, even an empty one, takes precedence over the profile. A Claude.ai subscription token cannot be used.

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
| `ANTHROPIC_API_KEY` | none | Turns the deck assistant on and pays for it |
| `ASSISTANT_MONTHLY_LIMIT_USD` | `3` | What each account may spend on the assistant per month, in US dollars |
| `ASSISTANT_ENABLED` | on with an API key | `true` turns the assistant on with an `ant auth login` profile instead of a key, `false` turns it off |
| `RENDERER_URL` | none | The slide renderer for the MCP server: `http://host:port` or `unix:/path/to/socket`. Without it, `render_slides` says images are unavailable |
| `CLOUDFLARE_R2_ACCESS_KEY_ID`, `CLOUDFLARE_R2_ACCESS_KEY_SECRET`, `R2_BUCKET` | none | Media uploads to Cloudflare R2, with `CLOUDFLARE_ACCOUNT_ID`. Without all four, media is off |
| `MEDIA_ACCOUNT_LIMIT_MB` | `1024` | Storage for the files in all of one account's projects, in megabytes |

| Endpoint | Purpose |
| --- | --- |
| `GET /api/projects` | The signed in person's projects with their decks |
| `POST /api/projects`, `PATCH` and `DELETE /api/projects/:id` | Create, rename, delete a project |
| `POST /api/projects/:id/decks` | Add a deck: a name and the deck's Yjs document in base64 |
| `PATCH` and `DELETE /api/decks/:id` | Rename, delete a deck |
| `GET /api/decks/:id/state` | The deck's Yjs document, as binary |
| `POST /api/import` | Move browser projects into the account. Running it twice adds nothing |
| `GET /api/shared` | Projects and single decks other people shared with the signed in person, with the owner and the role |
| `GET`, `POST /api/projects/:id/sharing` and `/api/decks/:id/sharing` | Who has access, and sharing with an email address as `editor` or `viewer` |
| `PATCH`, `DELETE .../sharing/members/:userId` and `.../sharing/invites/:inviteId` | Change a role or remove someone (owner), or leave (yourself) |
| `GET /api/assistant` | How much of this month's assistant allowance is used, and when it starts again |
| `/mcp` | The MCP server for Claude Code and other agents (see "Claude Code") |
| `POST /api/projects/:id/media`, then `POST /api/media/:id/finish` | Add a file to a project: ask for a signed upload link, PUT the file to it, then finish (see "Media uploads") |
| `GET /api/projects/:id/media` | The project's files, and how much of its owner's storage is used |
| `GET /api/media/:id`, `GET /api/media/:id/file`, `DELETE /api/media/:id` | A download link for one file (as JSON, or a redirect), and deleting it (owner) |
| `POST /api/decks/:id/assistant` | Ask the assistant about the open deck: its Markdown, a message and the chat so far. The reply streams as Server Sent Events: `text`, `deck` (new Markdown after each change), then `done` or `failed` |

Every deck written is checked with `@deyslide/deck-model` before it is saved, and at most 5 MB is accepted. Anything not shared with the person reads as not found, and a change their role does not allow is refused with 403 and a reason.

The BDD scenarios run the whole API on [PGlite](https://pglite.dev), Postgres compiled to WebAssembly, so `pnpm test` needs no database.

A new deck starts from one of two templates: **Blank** (one title slide) or **Demo deck** (`apps/deck/slides.md`, read with `fromMarkdown`).

## End to end tests

`pnpm test:e2e` runs `e2e/*.e2e.ts` with Playwright in headless Chromium, on a desktop and a phone screen. It starts everything it needs:

- the API from `apps/server` on [PGlite](https://pglite.dev), so no database is needed, with sent emails kept in memory so tests can open confirmation, magic link and reset links, and a keyword fake in place of Claude (`e2e/server.ts`, never deployed)
- the production build of the web app with `vite preview`, sending `/api`, `/mcp` and `/.well-known` to that API
- the slide renderer from `apps/renderer`, serving that build

It covers guest projects and decks, sign up, sign in, magic link, password reset, sign out, browser projects moving into the account and opening on a second browser, the editor and preview, the deck assistant, and Claude Code connecting through the MCP server, signing in, building a deck and getting real slide images. It is not part of CI. No test calls the real Claude API.

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
4. Runs `deploy/up.sh`, which starts the slide renderer and a Podman pod named `deyslide` with four containers:

   | Container | Image | Role |
   | --- | --- | --- |
   | `deyslide-db` | `postgres:18-alpine` | Database, data in the `deyslide-pgdata` volume. Kept running across deploys |
   | `deyslide-server` | `node:24-alpine` | The API on port 3001, running the bundled `server.mjs` |
   | `deyslide-app` | `nginx:stable-alpine` | Port 3000: web app, demo deck, and `/api/` passed to the API |
   | `deyslide-tunnel` | `cloudflared` | Publishes `app:3000` through the Cloudflare tunnel |

5. Checks that nginx answers at `/`, `/demo/` and `/api/health`, the tunnel connects, and the public URL serves all three.

The slide renderer (`deyslide-renderer`) runs outside the pod with `--network none`, since it runs decks' code. Its image is built on the server from `deploy/renderer/Containerfile`, on top of Playwright's image (about 2.5 GB, built once per Playwright version), and it talks to the API through a Unix socket in the `deyslide-sockets` volume. If it cannot start, the deploy goes on with a warning and `render_slides` says images are unavailable.

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
| `ANTHROPIC_API_KEY` | Secret | The deck assistant (optional) |
| `ASSISTANT_MONTHLY_LIMIT_USD` | Variable | The assistant's allowance per account and month, in US dollars (optional, default 3) |
| `CLOUDFLARE_R2_ACCESS_KEY_ID`, `CLOUDFLARE_R2_ACCESS_KEY_SECRET` | Secrets | Media uploads (optional), an R2 API token with Object Read & Write on the bucket. Needs `CLOUDFLARE_ACCOUNT_ID` too |
| `R2_BUCKET` | Variable | The private R2 bucket for media (optional, default `deyslide-private-assets`) |
| `MEDIA_ACCOUNT_LIMIT_MB` | Variable | Media storage per account, in megabytes (optional, default 1024) |

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
