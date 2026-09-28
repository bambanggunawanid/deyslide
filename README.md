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
```

Open the printed URL. In the deck, press `o` for the slide overview and `p` for presenter mode.

## Scripts

| Command | Output |
| --- | --- |
| `pnpm dev` | Deck development server with HMR |
| `pnpm dev:web` | Web app development server with HMR |
| `pnpm build` | Deck in `apps/deck/dist/` (served under `/demo/`) and web app in `apps/web/dist/` |
| `pnpm export` | PDF handout in `exports/deyslide.pdf` |
| `pnpm export:video` | WebM video in `exports/deyslide.webm` |
| `pnpm test` | BDD scenarios in `features/` |
| `pnpm typecheck` | Type check for the web app, the deck and the animations |

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
| A deck: slide outline and Markdown download | `/p/<project id>/d/<deck id>` |
| The demo deck, a separate Slidev build | `/demo/` |

Anyone can start right away, with no account. As a guest, the project list is kept in IndexedDB and every deck is a Yjs document stored with `y-indexeddb`, so work survives a reload but stays in that browser. A banner says so. Signing up to keep work in the cloud comes in the next phase.

A new deck starts from one of two templates: **Blank** (one title slide) or **Demo deck** (`apps/deck/slides.md`, read with `fromMarkdown`).

## Deck format

`packages/deck-model` defines the deck that the upcoming cloud editor saves and syncs (see the epic in issue #8).

- `DeckSchema` (Zod) validates a deck: slides with Slidev frontmatter, speaker notes, and elements. Element types are `text`, `image`, `shape`, `code` (one step, or several for a Magic Move), `scene3d`, `algo-player`, `sandbox`, and `raw` for Markdown the model does not understand.
- `toMarkdown(deck)` writes Slidev Markdown. Positioned elements use Slidev's own `<v-drag pos="x,y,w,h,rotate">` in Slidev canvas units (980 by 551.25), so plain Slidev renders the output. Slide ids live in frontmatter as `id`, element ids as `data-id`.
- `fromMarkdown(markdown)` reads it back. Anything it cannot represent exactly, including a `v-drag` block with a JavaScript expression, is kept byte for byte as a `raw` element.
- `deckToYDoc(deck)` and `yDocToDeck(doc)` map the deck to a Yjs document. Positions are per field and text is `Y.Text`, so concurrent moves and typing merge.

## Deployment

Every push to `main` runs `.github/workflows/deploy.yml`, which publishes the web app to https://deyslide.bambanggunawan.id and the demo deck to https://deyslide.bambanggunawan.id/demo/.

1. Builds the web app and the deck, and runs the BDD scenarios.
2. Joins the tailnet as `tag:ci` through the Tailscale OAuth client.
3. Uploads the site to `~/deyslide` on the server over Tailscale SSH, as user `ryzen`.
4. Runs `deploy/up.sh`, which starts a Podman pod named `deyslide` with two containers: `deyslide-app` (nginx on port 3000) and `deyslide-tunnel` (cloudflared).
5. Checks that nginx answers at `/` and `/demo/`, the tunnel connects, and the public URL serves both.

The pod has its own network and publishes no port, so port 3000 on the server stays free. Inside the pod, `app` points at the pod's loopback, which is how the Cloudflare tunnel route `http://app:3000` reaches nginx.

The `Production` environment holds:

| Name | Kind |
| --- | --- |
| `TAILSCALE_CLIENT_ID`, `TAILSCALE_CLIENT_KEY` | Secrets |
| `CLOUDFLARE_TUNNEL_TOKEN` | Secret |
| `TAILSCALE_SERVER_IP` | Variable |

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
