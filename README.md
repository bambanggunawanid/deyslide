# Deyslide

A hybrid presentation engine for two kinds of talks:

- **Live Teaching Mode**: workshops, live coding, flexible Q&A pacing, readable text and speaker tools.
- **Cinematic Presentation Mode**: conference keynotes, recorded videos, deep zoom 3D scenes and frame accurate algorithm animations.

Built on [Slidev](https://sli.dev) (Vue 3, Vite, UnoCSS, Shiki Magic Move), [TresJS](https://tresjs.org) for 3D, and [Motion Canvas](https://motioncanvas.io) for procedural 2D animation.

The hosted app at https://deyslide.bambanggunawan.id opens on a projects home page. A project holds decks, like a file in Figma. Decks are edited on a visual canvas or as Markdown, by several people at once, then presented full screen or exported to PDF and video. The demo deck plays at [/demo/](https://deyslide.bambanggunawan.id/demo/).

The same app runs on Windows, macOS, Linux and Android (see "The apps"), where decks can also live as Markdown files on the device and Claude Code edits them through an MCP server on that computer.

## Quick start

```bash
pnpm install
pnpm dev       # the demo deck in Slidev
pnpm dev:web   # the web app with the projects home page
pnpm dev:server  # the API, for accounts, cloud save and live editing (needs Postgres, see "API server")
pnpm dev:renderer  # slide images for the MCP server and exports (after pnpm build, see "Claude Code")
```

Open the printed URL. In the deck, press `o` for the slide overview and `p` for presenter mode.

## Scripts

| Command | Output |
| --- | --- |
| `pnpm dev` | Deck development server with HMR |
| `pnpm dev:web` | Web app development server with HMR |
| `pnpm dev:server` | API server, restarted on every change |
| `pnpm dev:renderer` | Slide renderer for the MCP server and exports, serving `apps/web/dist/` |
| `pnpm build` | Deck in `apps/deck/dist/` (served under `/demo/`), web app in `apps/web/dist/`, API in `apps/server/dist/server.mjs`, renderer in `apps/renderer/dist/renderer.mjs` |
| `pnpm export` | PDF handout of the demo deck in `exports/deyslide.pdf` |
| `pnpm export:video` | WebM video of the demo deck in `exports/deyslide.webm` |
| `pnpm test` | BDD scenarios in `features/`. Builds the on-device MCP server with cargo first, so it needs Rust |
| `pnpm test:e2e` | End to end tests in a real browser, local only (see "End to end tests") |
| `pnpm typecheck` | Type check for the web app, the API, the deck and the animations |
| `pnpm guide:sync` | Copies the hosted MCP server's tools, guide and instructions into `crates/deyslide-core/src/` for the on-device server. Run it after changing `apps/server/src/mcp/` |
| `pnpm --filter @deyslide/web build:app` | The web app as the apps show it, in `apps/web/dist-app/` (`dev:app` serves it with HMR) |
| `pnpm --filter @deyslide/native build` | The app installers for this system (see "The apps") |
| `pnpm --filter @deyslide/native android:build` | The Android app |

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

`apps/web` is a Vue 3 and Vite single page app: the editor, presenting and export for every deck, on the website and inside the apps.

| Page | Path |
| --- | --- |
| Projects home page | `/` |
| A project and its decks | `/p/<project id>` |
| A deck, in the Design view (canvas) or the Markdown view | `/p/<project id>/d/<deck id>` |
| Presenting a deck, and the presenter view | `/p/<project id>/d/<deck id>/present`, `/p/<project id>/d/<deck id>/presenter` |
| Sign in, sign up, forgot and reset password | `/sign-in`, `/sign-up`, `/forgot-password`, `/reset-password` |
| Downloads for the apps | `/download` |
| The demo deck, a separate Slidev build | `/demo/` |

Anyone can start right away, with no account. As a guest, the project list is kept in IndexedDB and every deck is a Yjs document stored with `y-indexeddb`, so work survives a reload but stays in that browser. A banner says so.

Signed in, projects and decks live in the account and open on any device. Signing in moves the browser's projects into the account, keeping their ids so old links still work, and then clears them from the browser. If the move fails, they stay in the browser and the move is tried again at the next sign in.

### Sharing

Signed in people share a project, or a single deck, from its **Share** button, by email:

| Role | Can |
| --- | --- |
| Owner | Everything: share, change roles, remove people, delete |
| Editor | Open, edit, rename, add decks to a shared project, and share with others |
| Viewer | Open, read and present, and see other people's changes live. The deck page says "View only" and nothing can be changed |

- A deck's role is the higher of its own and its project's, so a viewer of a project can be an editor of one deck in it.
- Only the owner changes roles and removes people. Anyone else can leave.
- Someone with an account gets a "shared with you" email and finds the work under **Shared with you** on the home page. An address without an account gets an invite, which turns into access when someone signs up with that address and confirms it.
- The deck assistant and the MCP server follow the same roles: viewers can read a deck, not change it.
- Deleting a project or deck ends its sharing and cancels its invites. Each project or deck holds at most 50 people and invites.

The pages talk to one `ProjectStore` interface (`apps/web/src/projects/`): `GuestStore` for the browser, `CloudStore` for the account, and `LocalStore` for the library folder in the apps. `Workspace` picks the store for each project by its id (projects on a device have ids that start with `local-`), and switches stores on sign in and sign out.

The sign in page offers only what the API reports as configured at `/api/config`, so a missing Google app hides the Google button instead of breaking it.

### Live editing

A deck opens as one live Yjs document that both views, the assistant and Claude Code change together. Decks in an account join a room on the API through a WebSocket at `/api/collab` ([Hocuspocus](https://tiptap.dev/docs/hocuspocus/introduction), one room per deck). Guest decks share one document per deck inside the browser, and decks on a device are read from and written to their files.

- A deck is read only until it has synced, and for viewers. The header says `Connecting...`, `Saving...`, `Saved`, `Offline. Changes sync when you are back online.`, or `Not saved` with the reason.
- Changes made offline stay in the tab until the server has them, even after leaving the deck, and the browser asks before such a tab closes.
- Everyone in the deck shows as an avatar in the header and as a dot on their slide in the slide strip. On the canvas, other people's selections show as colored outlines with their name, their pointers as small labeled cursors, and the text cursors of anyone editing the same text box. Names and colors come from the server, so nobody can pose as someone else.
- Deleting a deck or project, removing someone, changing a role, leaving, signing out and an expired app token close the affected connections, and people reconnect with the access they have now. Someone who lost access sees "You no longer have access to this deck."
- A room refuses a deck past 200,000 characters of Markdown, 500 slides or 5 MB, and everyone in it sees "This deck is too big to save. Remove some content." A single change over 2 MB, or one that would take the deck's data past 5 MB, is refused before the room takes it in: only the page that sent it is let go, with the same message. A page that writes anything outside the deck is let go too, and presence passes on only the known fields (who, view, slide, selection, pointer, text cursor), up to 8 KB.
- Rooms load from the database, store a couple of seconds after changes stop (and try again when a store fails), and repair a deck that concurrent edits left invalid, for everyone at once.

### Design view

The deck page opens in Design: the real slide, drawn by the preview, under an overlay at its scale (`apps/web/src/canvas/`). `?view=design` or `?view=markdown` picks the view, and the browser remembers the last choice. Slide buttons and a click stepper, for `v-click`, `v-clicks` and Magic Move steps, work in both views.

| Do | With a mouse | With touch |
| --- | --- | --- |
| Select | Click, Shift adds | Tap |
| Move | Drag, with guides that snap to the slide's edges and center lines and to other boxes. Alt or Option turns snapping off | Drag |
| Resize, rotate | Eight handles, Shift keeps the ratio. The rotate handle turns, Shift snaps to 15 degrees | Larger handles |
| Edit text in place | Double click. Escape or a click outside closes it | Double tap |
| Zoom | Ctrl or Cmd and the wheel, or the zoom menu (Fit, 50, 100, 200 percent) | Pinch, and two fingers pan |
| Reorder slides | Drag in the slide strip | Long press, then drag |

Arrows nudge the selection by 1 (Shift by 10), Delete or Backspace removes it, Ctrl or Cmd D duplicates it, and Escape clears it. Ctrl or Cmd Z undoes, and Ctrl or Cmd Shift Z or Ctrl or Cmd Y redoes. Undo covers the canvas and the Markdown view together, and a whole drag is one step. While a box is dragged, the preview moves it without rebuilding the slide.

- **Toolbar**: text, image, rectangle, ellipse, code, 3D scene, algorithm player and live sandbox, placed in the middle of the slide and selected. Signed in, images can come from the project's media library (see "Media uploads"), and media images show in the preview.
- **Inspector**: position, size and rotation, each block's settings (fill and stroke, image source and alt text, code language and Magic Move steps, the 3D camera, the player, the sandbox's starting values) and stacking order. With nothing selected, it shows the slide's layout, class, background, transition and clicks, its Markdown blocks (edit one, or make it a movable box) and the speaker notes. On phones it is a bottom sheet.
- **Slide strip**: numbers, titles and who is on which slide. It adds, duplicates, deletes and reorders slides. On wide screens it shows live thumbnails; on phones it is a row you swipe.
- Viewers, and everyone while the assistant works on the deck, see the canvas without its tools.

### Markdown view

The Markdown view is the same live deck as Slidev Markdown in CodeMirror, beside a preview of the slide under the cursor. On phones, tabs switch between writing and the preview.

- Typing merges into the deck 300 ms after the last key. Changes from others patch only the slides they touched, so the cursor stays where it is.
- Structure that is half typed, such as an open HTML comment or code fence, waits quietly until it is finished.
- Markdown that cannot be read shows its error under the editor and changes nothing. Changes from others wait meanwhile ("Fix the error to see others' changes."), and arrive once it reads again.

### Slide preview

The preview renders Slidev Markdown the way Slidev does, in the browser (`apps/web/src/preview/`):

1. The slide is split on `::name::` lines into slots, and each part goes through markdown-it with Vue components allowed, as in Slidev. Code is highlighted with Shiki and wrapped in `v-pre`, so it is shown and never evaluated.
2. The result is compiled as a Vue template on the fly, inside the slide's layout. Slidev's own layouts and the default theme's styles are used, and UnoCSS generates utility classes as slides use them. Fonts named in the deck's `fonts` settings load from Google Fonts, as in Slidev.
3. Deyslide components (3D scene, algorithm player, live sandbox, shape) load when a slide uses them.

Stepping through clicks keeps the slide mounted, so Magic Move animates and 3D cameras glide. The same preview presents slides with Slidev's transitions, draws them in print mode for PDFs, and captures a finished slide as a PNG.

A deck can run code, and decks are shared, so the preview is its own page (`preview.html`) in an iframe with `sandbox="allow-scripts"`. It has an opaque origin: no access to the app, its storage, its cookies or the API. The editor talks to it with `postMessage`. Because of that origin, the preview's scripts load as cross origin requests, which is why nginx and Vite allow any origin on static assets. For the same reason, media files reach the preview as short lived signed links.

### Presenting

**Present** in the deck header, or next to each deck on its project page, shows one slide full screen on black, with Slidev's transitions (reversed when going back). The talk follows the live deck, so changes others make show up while presenting.

| Keys | Action |
| --- | --- |
| Right, Down, Space, Page Down, `n`, Enter | Next click step or slide |
| Left, Up, Page Up, `p`, Backspace | Back. A previous slide opens at its last click, as in Slidev |
| Home, End | First and last slide |
| `f` | Full screen |
| `o` | Overview of every slide. Click one to jump to it |
| `g` | Go to a slide number |
| `a` | Autoplay on or off |
| Escape | Leaves the overview, then full screen, then returns to the editor on the slide the talk ended on |

A click or tap on the left third goes back and anywhere else goes on; a swipe works on touch screens. The cursor and the controls hide after 2 seconds of rest.

- **Live Teaching** mode (the default) moves only when the speaker does.
- **Cinematic** mode plays each click step for the slide's `videoDwell` seconds, or 4 seconds, and can loop. `?mode=cinematic&loop=1` in the address starts it that way.

**Presenter view** shows the current slide, the next step, the speaker notes, a timer with a reset, the clock and the slide and click counters, and takes the same keys to move. It opens the audience window and keeps it in step: in the browser through a second window and a `BroadcastChannel`, in the app on a computer through a second app window, and on Android in the same window.

### Export

The **Export** menu, in the deck header and in the presenter view, offers:

| Choice | Made by | For |
| --- | --- | --- |
| PDF, PDF with every click step, Video (WebM) | The server, as an export job with progress | Signed in people, when the server has a slide renderer |
| PDF (this device), with or without every click step | The browser or the app, from the preview | Anyone not signed in, and anyone whose server cannot make exports or cannot be reached |

Server exports render at 1920 by 1080. A video presents the deck with its transitions and holds each click step for the slide's `videoDwell` seconds, or 3 seconds. Decks on a device are sent as Markdown. The file is saved through the browser, or through the system's save dialog in the apps. See "API server" for the limits.

### Deck assistant

Signed in people can ask Claude to change the open deck from a chat next to the slides: "Add a slide that compares bubble sort and merge sort", "Reveal the points on slide 3 one click at a time". Each change lands in the live deck as Claude makes it, for everyone who has it open, and the preview jumps to the slide it touched; in the Markdown view it goes back to following the cursor once you move it. Work other people do meanwhile is kept. Editing waits until the reply is done. **Undo** takes back the assistant's latest edits as one step and keeps anything typed elsewhere since. Once someone writes in a slide Claude added, the button goes away, since it would remove that text as well. Guests see a link to sign in.

The browser sends the deck's Markdown and the chat with each message (`apps/web/src/assistant/`). On the server (`apps/server/src/assistant/`), Claude gets that Markdown with numbered slides and four tools: `replace_slide`, `insert_slide`, `delete_slide` and `move_slide`. The tools change a copy of the Markdown in memory, and a change that would split a slide in two, break its frontmatter YAML or make an unreadable deck goes back to Claude as an error instead. Claude has no tool that reads the database or any other deck, and a request for a deck the person does not own is refused before Claude sees anything.

## Media uploads

Every project has a media library: images, video and audio for its slides. Files are private, in a private Cloudflare R2 bucket under `projects/<project id>/`, and there is no public address for them. The canvas's image tool lists, uploads and picks them, and slides name a file `/api/media/<id>/file`.

- Everyone the project is shared with can see and open its files. Editors add files, and only the owner deletes them. Someone given a single deck can open only the files that deck's slides use through `/api/media/<id>/file`.
- Each account has 1 GB (`MEDIA_ACCOUNT_LIMIT_MB`) for the files in all the projects it owns. A file an editor adds counts toward the project owner's storage.
- Accepted: PNG, JPEG, GIF, WebP, AVIF, MP4, WebM, MOV, MP3, M4A, OGG and WAV, up to 100 MB each. SVG is refused, since it can carry scripts.
- Uploads go straight from the browser to R2 with a signed link that works for 15 minutes and only for the declared type and size, so large files never pass through the API or the tunnel.
- Finishing an upload checks the stored size and the file's first bytes against its type. A file that is not what it claims is deleted.
- Downloads use signed links that also work for 15 minutes, so removing someone from a project soon ends their access. `GET /api/media/:id/file` redirects to a fresh one, so slides can use a stable address.
- Slide previews (the editor, the strip, presenting, the overview and PDFs made on the device) ask for links through the deck they show, with `GET /api/decks/:deckId/media/:id`, which only links files of that deck's own project. Slides can run code that reads the links, so a deck elsewhere that names a file never gets one, whoever opens it. Links are kept per deck in the page, and decks on the device or in a guest's browser ask for none.
- Deleting a project deletes its files. Uploads never finished are cleaned up after a day.

The browser talks to R2 directly, so the bucket needs a CORS policy. In the Cloudflare dashboard, open the bucket, then **Settings**, **CORS policy**, and add:

```json
[
  {
    "AllowedOrigins": ["https://deyslide.bambanggunawan.id", "tauri://localhost", "http://tauri.localhost"],
    "AllowedMethods": ["PUT", "GET", "HEAD"],
    "AllowedHeaders": ["content-type"],
    "MaxAgeSeconds": 3600
  },
  {
    "AllowedOrigins": ["null"],
    "AllowedMethods": ["GET"],
    "MaxAgeSeconds": 3600
  }
]
```

`tauri://localhost` and `http://tauri.localhost` are the pages of the apps (the first on macOS and Linux, the second on Windows and Android), which upload files with their own `fetch`. `null` is the sandboxed slide preview, which reads images through signed links when it draws a slide to a PNG. For local development, add `http://localhost:5173` to the first rule's `AllowedOrigins`.

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

Everything is checked the way the web app checks it, and every call reaches only the signed in person's decks. There are no delete tools. Claude Code writes into the deck's live room, so a deck open in the browser shows its changes at once. `read_deck` remembers what each MCP session saw, so `write_deck` and `edit_slides` merge against that read: edits people made meanwhile are kept, and slide numbers mean what Claude saw. `render_slides` sends the images and videos its slides use to the renderer, only files the person may open and at most 20 MB per call, and names any file it left out.

How it fits together:

- **Sign in** (`apps/server/src/auth.ts`): Better Auth's [OAuth provider](https://www.better-auth.com/docs/plugins/oauth-provider) with dynamic client registration and PKCE. MCP clients register themselves with a loopback redirect, so they are registered as native apps. Access tokens are JWTs whose audience is the MCP endpoint, valid for an hour and refreshed by the client. The apps sign in through the same provider for the API instead (see "API server"). The consent page is `apps/web/src/pages/ConsentPage.vue`.
- **Discovery**: `/.well-known/oauth-protected-resource/mcp` names the authorization server, and `/.well-known/oauth-authorization-server/api/auth` describes it. A call without a valid token gets 401 with a `WWW-Authenticate` header that points to the first.
- **MCP server** (`apps/server/src/mcp/`): Streamable HTTP at `/mcp`, stateless, with one server per request bound to the token's account. A client gets a session id when it starts, so the server can remember what each session last read of a deck, for an hour.
- **Renderer** (`apps/renderer/`): draws slides with the web app's own preview in headless Chromium, so images match the editor. Each request gets a fresh browser context that can only load the web app's files; in production the container also has no network, and the API reaches it through a Unix socket. It checks whether anything is drawn past the slide's edges to report overflow. Exports use it too: PDFs from batches of slide images, and WebM videos recorded on a queue of their own, so `render_slides` never waits behind a long video.
- **Plugin** (`.claude-plugin/marketplace.json`, `plugins/deyslide/`): the MCP server settings and the `deyslide` skill.
- **On-device server** (`crates/deyslide-core/`): the same tools for decks kept as files on a computer, served over stdio by the app (see "Claude Code on this computer"). `pnpm guide:sync` copies the hosted tools, guide and instructions into it, and the scenarios fail when the copies drift.

To try it locally, run `pnpm build`, then `pnpm dev:server` with `RENDERER_URL=http://127.0.0.1:3102` in `apps/server/.env`, `pnpm dev:renderer` and `pnpm dev:web`, and add `http://localhost:5173/mcp` to Claude Code. The renderer uses Playwright's Chromium, or the one in `CHROMIUM_PATH`.

## The apps

`apps/native` is the Deyslide app for Windows, macOS, Linux and Android, built with [Tauri 2](https://tauri.app) around the web app. It adds what a browser cannot do: decks kept as Markdown files on the device, and an MCP server so Claude Code on the same computer edits them. Signed in, it opens the decks in the account too, live, like the website.

### Downloads

The [/download](https://deyslide.bambanggunawan.id/download) page links to the newest files on [GitHub Releases](https://github.com/bambanggunawanid/deyslide/releases), and the site's header has a **Get the app** link to it.

| System | File |
| --- | --- |
| Windows | An installer (`-setup.exe`), or an `.msi` |
| macOS | A disk image (`.dmg`) with one app for Apple silicon and Intel Macs |
| Linux | An `.AppImage` or a `.deb`, for Ubuntu 22.04, Debian 12 and newer |
| Android | An `.apk` for 64 bit and 32 bit ARM phones |

The builds are not signed by Apple or Microsoft yet, so each system asks once:

- **macOS**: drag Deyslide into Applications and start it from there. When macOS says it could not verify the app, choose Done, then go to System Settings, Privacy & Security, and click Open Anyway next to the line about Deyslide.
- **Windows**: if SmartScreen warns about an unknown publisher, choose More info, then Run anyway.
- **Linux**: make the AppImage executable (`chmod +x`) and run it, or install the `.deb`.
- **Android**: open the APK on the phone and, when asked, allow the browser to install apps.

### Decks on the device

The home page shows **On this device** and, signed in, **Your account**. On the device, a project is a folder in the library folder and a deck is a `.md` file in it, holding plain Slidev Markdown that any editor can open. The library folder is `Documents/Deyslide` on a computer (the home page shows it, with a **Change** button) and a folder inside the app on Android.

- A change in the app is written to its file a moment later, and only when the deck differs from the file. Each write checks that the file still holds what the app last read or wrote, so a file Claude Code or another editor changed meanwhile is merged in, never overwritten.
- Changes made to a file on disk appear in the open deck at once and merge with any typing.
- A file that does not parse pauses writing and says "The file on disk has an error: ..." until a later change reads, and a deck moved or renamed on disk says so.
- Closing the window, or the app going to the background, writes what is waiting first and sends account decks' changes to the server. When some cannot be saved (offline, say), closing asks before it goes without them.
- Deleting a project or deck moves it to the system's trash when there is one.

Decks on a device are not shared and have no live room. Export from them makes a PDF on the device, or, signed in, sends their Markdown to the server for a PDF or a video.

### Signing in

**Sign in with your browser** opens the system browser to sign in to Deyslide. After the consent page, which asks for full access to the account, the browser hands the app back an authorization code: through a callback on `127.0.0.1` on a computer, or through the app's own link (`id.bambanggunawan.deyslide:/oauth/callback`) on Android. The app keeps its tokens in `auth.json` in its data folder and refreshes them on its own. It signs in to the public server unless `serverUrl` in its `settings.json` names another, which takes effect after a restart.

### Claude Code on this computer

On a computer, the same program is also an MCP server for the decks in the library folder (`deyslide mcp`, over stdio). It works offline and needs no account. Under **Connect Claude Code**, the home page shows the exact command for this install with a **Copy** button. It looks like this:

```bash
claude mcp add --scope user deyslide-local -- "<path to Deyslide>" mcp
```

On macOS, move Deyslide to Applications first: a copy started from the disk image, or one macOS moved to a temporary place, gets no command, only "Move Deyslide to Applications, then open it again."

- The tools are the hosted ones. `list_decks` shows each deck's file path instead of an editor link.
- `write_deck` and `edit_slides` save nothing until Claude has read the deck with `read_deck`, and nothing over a file that changed on disk since that read or Claude's last write. Claude then reads it again.
- `render_slides` draws the slides in the app, which must be open while it draws. When it is closed, the server starts it and waits up to 20 seconds; with no app at all, it answers "Open the Deyslide app to see slide images. The deck is saved."

The app and `deyslide mcp` share a data folder, `id.bambanggunawan.deyslide` inside the system's data folder (`DEYSLIDE_DATA_DIR` moves it): `settings.json` (the library folder and the server), `auth.json`, the library lock, and `render-bridge.json`, through which the server finds the open app. The bridge listens on `127.0.0.1` only and answers only requests that carry its random token.

For the decks in an account, add the hosted server instead (see "Claude Code"). Both can be added side by side.

How the apps are built, run and released: [`apps/native/README.md`](apps/native/README.md) and "Releases" below.

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
| `RENDERER_URL` | none | The slide renderer for the MCP server and exports: `http://host:port` or `unix:/path/to/socket`. Without it, `render_slides` says images are unavailable and the Export menu offers only PDFs made on the device |
| `CLOUDFLARE_R2_ACCESS_KEY_ID`, `CLOUDFLARE_R2_ACCESS_KEY_SECRET`, `R2_BUCKET` | none | Media uploads to Cloudflare R2, with `CLOUDFLARE_ACCOUNT_ID`. Without all four, media is off |
| `MEDIA_ACCOUNT_LIMIT_MB` | `1024` | Storage for the files in all of one account's projects, in megabytes |

| Endpoint | Purpose |
| --- | --- |
| `GET /api/config` | What this server offers: email sign in, Google, GitHub, the assistant, media and exports |
| `GET /api/me` | The signed in person's id, name and email. The apps ask, since they hold a token and no session |
| `GET /api/projects` | The signed in person's projects with their decks |
| `POST /api/projects`, `PATCH` and `DELETE /api/projects/:id` | Create, rename, delete a project |
| `POST /api/projects/:id/decks` | Add a deck: a name and the deck's Yjs document in base64 |
| `PATCH` and `DELETE /api/decks/:id` | Rename, delete a deck |
| `GET /api/decks/:id/state` | The deck's Yjs document as it is in its live room, as binary |
| `PUT /api/decks/:id/state` | Saves a whole deck from a Yjs document, merged into the live deck, for pages from before live editing. Refused with 400 while people have the deck open live |
| `/api/collab` | The WebSocket for live editing: one Hocuspocus room per deck, named `deck:<deck id>` (see "Live editing") |
| `POST /api/import` | Move browser projects into the account. Running it twice adds nothing |
| `GET /api/shared` | Projects and single decks other people shared with the signed in person, with the owner and the role |
| `GET`, `POST /api/projects/:id/sharing` and `/api/decks/:id/sharing` | Who has access, and sharing with an email address as `editor` or `viewer` |
| `PATCH`, `DELETE .../sharing/members/:userId` and `.../sharing/invites/:inviteId` | Change a role or remove someone (owner), or leave (yourself) |
| `GET /api/assistant` | How much of this month's assistant allowance is used, and when it starts again |
| `/mcp` | The MCP server for Claude Code and other agents (see "Claude Code") |
| `POST /api/projects/:id/media`, then `POST /api/media/:id/finish` | Add a file to a project: ask for a signed upload link, PUT the file to it, then finish (see "Media uploads") |
| `GET /api/projects/:id/media` | The project's files, and how much of its owner's storage is used |
| `GET /api/media/:id`, `GET /api/media/:id/file`, `DELETE /api/media/:id` | A download link for one file (as JSON, or a redirect), and deleting it (owner) |
| `GET /api/decks/:deckId/media/:id` | A download link for a slide preview, only for a file of the deck's own project (JSON) |
| `POST /api/decks/:id/assistant` | Ask the assistant about the open deck: its Markdown, a message and the chat so far. The reply streams as Server Sent Events: `text`, `deck` (new Markdown after each change), then `done` or `failed` |
| `POST /api/exports` | Start an export of a deck (`deckId`, any role) or of Markdown (`markdown`, for decks on a device) as `format` `pdf` or `webm`, with `options.clicks` (`last` or `each`) and `options.dwellMs`. Answers 202 with an `id` |
| `GET /api/exports/:id`, `GET /api/exports/:id/file` | An export's `status` (`queued`, `running`, `done` or `failed`), `progress` and `error`, and its file once it is done |

Every deck written is checked with `@deyslide/deck-model` before it is saved, and at most 5 MB is accepted. Anything not shared with the person reads as not found, and a change their role does not allow is refused with 403 and a reason.

Routes for signed in people take the session cookie, or an access token from one of the apps as `Authorization: Bearer <token>`. Better Auth's own routes under `/api/auth/` take the cookie only.

The apps get those tokens from the OAuth provider Claude Code signs in with (see "Claude Code"), for a second resource: the API, `<PUBLIC_URL>/api`, next to the MCP endpoint. Only native clients whose redirect URIs are all `http://127.0.0.1/callback` (on any port) or `id.bambanggunawan.deyslide:/oauth/callback` may register for it, and they cannot move their redirect elsewhere later. Such a client that names no resource when it asks gets the API, and the consent page then says it wants full access to the account, including deleting and sharing. Every other client, Claude Code included, gets the MCP resource only. A token for one resource is refused by the other.

Live rooms (`apps/server/src/collab/`) let in a session cookie only from a page on `PUBLIC_URL`, or an access token for the API. Viewers join read only, and anyone else is refused as if the deck did not exist. Every server reader and writer, the MCP server and exports included, goes through the deck's live room.

Exports (`apps/server/src/exports/`) run in the background, since the tunnel ends requests after 100 seconds. The page polls for progress and then downloads the file.

| Limit | Value |
| --- | --- |
| Running at once | One per account and two in all, at most one of them a video. The rest wait in a queue |
| Under way per account | 3 (a fourth answers 429) |
| Slides | 100 per export |
| PDF | 300 pages, 500 MB |
| Video | 10 minutes, each click step held for 0.5 to 60 seconds (`dwellMs`, default 3 seconds, or the slide's `videoDwell`) |
| Media | 20 MB of the slides' images and videos, sent to the renderer as data URLs |
| Files kept | An hour, or 10 minutes after the download. Each account keeps its 3 newest, and the server at most 2 GB |

Access is checked again when an export starts and on every poll. Exports in progress stop, and their files go, when the server stops.

The BDD scenarios run the whole API on [PGlite](https://pglite.dev), Postgres compiled to WebAssembly, so `pnpm test` needs no database.

A new deck starts from one of two templates: **Blank** (one title slide) or **Demo deck** (`apps/deck/slides.md`, read with `fromMarkdown`).

## End to end tests

`pnpm test:e2e` runs `e2e/*.e2e.ts` with Playwright in headless Chromium, on a desktop and a phone screen. It starts everything it needs:

- the API from `apps/server` on [PGlite](https://pglite.dev), so no database is needed, with live rooms, sent emails kept in memory so tests can open confirmation, magic link and reset links, and a keyword fake in place of Claude (`e2e/server.ts`, never deployed)
- the production build of the web app with `vite preview`, sending `/api` (WebSockets included), `/mcp` and `/.well-known` to that API
- the slide renderer from `apps/renderer`, serving that build, for slide images and exports

It covers guest projects and decks, sign up, sign in, magic link, password reset, sign out, browser projects moving into the account and opening on a second browser, sharing, two people editing one deck live, the canvas with a mouse and with fingers, the Markdown view and preview, presenting and the presenter view, PDF exports on the device and on the server, the deck assistant, and Claude Code connecting through the MCP server, signing in, building a deck and getting real slide images. It is not part of CI. No test calls the real Claude API. The apps are not covered here; their Rust code has its own tests (see [CONTRIBUTING.md](CONTRIBUTING.md)).

Install Chromium once with `pnpm exec playwright install chromium`. To use a Chromium you already have instead, set `PLAYWRIGHT_CHROMIUM_PATH` to its executable. After a failure, `pnpm exec playwright show-trace test-results/<test>/trace.zip` replays it step by step.

## Deck format

`packages/deck-model` defines the deck that every editor, the server and Claude Code save and sync.

- `DeckSchema` (Zod) validates a deck: slides with Slidev frontmatter, speaker notes, and elements. Element types are `text`, `image`, `shape`, `code` (one step, or several for a Magic Move), `scene3d`, `algo-player`, `sandbox`, and `raw` for Markdown the model does not understand.
- `toMarkdown(deck)` writes Slidev Markdown. Positioned elements use Slidev's own `<v-drag pos="x,y,w,h,rotate">` in Slidev canvas units (980 by 551.25), so plain Slidev renders the output. Slide ids live in frontmatter as `id`, element ids as `data-id`.
- `fromMarkdown(markdown)` reads it back. Anything it cannot represent exactly, including a `v-drag` block with a JavaScript expression, is kept byte for byte as a `raw` element.
- `deckToYDoc(deck)` and `yDocToDeck(doc)` map the deck to a Yjs document. Positions are per field and text is `Y.Text`, so concurrent moves and typing merge.
- The Yjs document is the single source of truth while a deck is open. `applyMarkdown` and `applyDeck` change it with the fewest operations: slides and boxes are lined up by the ids written in the Markdown, then by content, then by position, so untouched slides keep their ids and shared text.
- `mergeMarkdown` and `forkMarkdown` apply Markdown written against an older state through a fork of that state, so the Markdown view, the assistant, Claude Code and a file on disk never undo each other's work.
- Structural edits (`insertSlide`, `moveSlide`, `updateElement`, `makeMovable` and the others in `edit.ts`) each run as one checked transaction. `readDeckDoc` reads a deck tolerantly and `repairDeckDoc` fixes one that concurrent edits left invalid.
- Markdown that would split a slide when written out is escaped without changing how Slidev renders it. Half typed structure, such as an open comment or code fence, is reported as a `typing` error instead of reshaping the deck.

## Deployment

Every push to `main` runs `.github/workflows/deploy.yml`, which publishes the web app to https://deyslide.bambanggunawan.id, the demo deck to https://deyslide.bambanggunawan.id/demo/ and the API under https://deyslide.bambanggunawan.id/api/.

1. Builds the web app, the deck and the API bundle, and runs the BDD scenarios (with Rust installed, since they build the on-device MCP server).
2. Joins the tailnet as `tag:ci` through the Tailscale OAuth client.
3. Uploads the release and the API settings to `~/deyslide` on the server over Tailscale SSH, as user `ryzen`.
4. Runs `deploy/up.sh`, which starts the slide renderer and a Podman pod named `deyslide` with four containers:

   | Container | Image | Role |
   | --- | --- | --- |
   | `deyslide-db` | `postgres:18-alpine` | Database, data in the `deyslide-pgdata` volume. Kept running across deploys |
   | `deyslide-server` | `node:24-alpine` | The API on port 3001, running the bundled `server.mjs`, with the live rooms and export jobs |
   | `deyslide-app` | `nginx:stable-alpine` | Port 3000: web app, demo deck, and `/api/` and `/mcp` passed to the API |
   | `deyslide-tunnel` | `cloudflared` | Publishes `app:3000` through the Cloudflare tunnel |

5. Checks that nginx answers at `/`, `/demo/` and `/api/health`, the tunnel connects, and the public URL serves all three.

The slide renderer (`deyslide-renderer`) runs outside the pod with `--network none`, since it runs decks' code. Its image is built on the server from `deploy/renderer/Containerfile`, on top of Playwright's image (about 2.5 GB, built once per Playwright version), and it talks to the API through a Unix socket in the `deyslide-sockets` volume. If it cannot start, the deploy goes on with a warning and `render_slides` says images are unavailable.

nginx passes the live editing WebSocket through its own `location = /api/collab` (`deploy/nginx.conf`), with the upgrade headers, no buffering and a one hour read timeout. The API pings idle sockets every 30 seconds, well inside it.

When the API is asked to stop, as when a deploy replaces its container, it stops the exports in progress, closes the live rooms and waits up to 8 seconds, inside Podman's 10 second stop timeout, until every open deck is stored. It logs any deck it could not store. People's pages keep their changes and send them again when they reconnect to the new server.

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

## Releases

Pushing a version tag such as `v0.2.0` runs `.github/workflows/release.yml` (see [CONTRIBUTING.md](CONTRIBUTING.md) for how to release). It creates a draft GitHub Release with notes generated from the merged pull requests, builds the apps with the tag's version, attaches them, and publishes the release only when all four builds passed. Otherwise it stays a draft for a person to finish. **Run workflow** on the Release workflow builds the same files as workflow artifacts, version `0.0.<run number>`, and publishes nothing.

| Job | Runs on | Release assets |
| --- | --- | --- |
| Windows | `windows-latest` | `-setup.exe` (NSIS), and an `.msi` when Windows Installer accepts the version (a pre-release such as `1.2.3-beta.1` gets the setup only) |
| macOS | `macos-latest` | A universal `.dmg` for Apple silicon and Intel |
| Linux | `ubuntu-22.04` | `.AppImage` and `.deb` |
| Android | `ubuntu-latest` | A universal `.apk` for `aarch64` and `armv7`, attached only when it is release signed |

The macOS app is signed ad hoc unless the repository has the Apple secrets `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD` and `APPLE_TEAM_ID`. The Windows installers are not signed.

The Android APK is signed with the project's own key, from four repository secrets:

| Secret | Holds |
| --- | --- |
| `ANDROID_KEYSTORE_BASE64` | The keystore file, in base64 |
| `ANDROID_STORE_PASSWORD` | The keystore's password |
| `ANDROID_KEY_ALIAS` | The key's alias |
| `ANDROID_KEY_PASSWORD` | The key's password |

Without all four, the APK is unsigned and stays a workflow artifact, since it cannot be installed. Keep the keystore safe: every update must carry the same signature, and reinstalling the app to change keys deletes the decks kept inside it.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md). Every change starts with an issue, and every behavior starts with a Gherkin scenario.

## License

[MIT](LICENSE)
