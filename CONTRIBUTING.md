# Contributing to Deyslide

Thank you for helping. This guide covers the full path from an idea to a released change.
By taking part you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Requirements

- Node.js 24 (the version is pinned in `.node-version`)
- pnpm 10 (the exact version is pinned in `package.json` under `packageManager`)
- Rust, stable, installed with [rustup](https://rustup.rs). `pnpm test` builds the on-device MCP server (`crates/deyslide-core`) with cargo before any scenario runs.
- Chromium for `pnpm export`, `pnpm export:video` and `pnpm test:e2e`. Run `pnpm exec playwright install chromium` once.
- For the apps only: the [Tauri prerequisites](https://tauri.app/start/prerequisites/) for your system (on Linux, WebKitGTK 4.1 and its build packages, which `cargo clippy --workspace` and `cargo test --workspace` need too). For Android, also the Android SDK, the NDK, JDK 21 and the Rust Android targets.

## The contribution flow

### 1. Start with an issue

Every change begins with an issue, including small fixes.

- Search [existing issues](https://github.com/bambanggunawanid/deyslide/issues) first.
- Open a new one with the **Bug report** or **Feature request** template.
- For features, wait until a maintainer confirms the scope before you start coding.
- Comment on the issue to say you are working on it, so nobody duplicates the effort.

### 2. Create a branch

Fork the repository, then branch from `main`:

```
<type>/<issue-number>-<short-description>
```

Examples: `feat/12-gltf-camera-paths`, `fix/31-player-loop-reset`.

### 3. Write the scenario first (BDD)

Deyslide uses behavior driven development. Before you change code:

1. Describe the behavior in Gherkin, in `features/<name>.feature`.
2. Add the step definitions in `features/<name>.spec.ts` with `@amiceli/vitest-cucumber`.
3. Run `pnpm test` and watch the new scenario fail.
4. Write the code until it passes.

A small example:

```gherkin
Feature: Sandbox state model

  Scenario: Toggle a boolean
    Given a sandbox with debug off, retries 2 and name "demo"
    When I toggle "debug"
    Then "debug" is true
```

Logic that needs no browser lives in plain TypeScript under `packages/components/src/` so the scenarios stay fast.
Components are tested with `@vue/test-utils` in happy-dom. WebGL and the Motion Canvas element are replaced with stubs, as the existing specs show.
Specs that need the apps' Tauri plugins mock them by their file under `apps/web/node_modules`, as `features/app-platform.spec.ts` does.

Rust code has unit tests next to it (`cargo test --workspace`), and `features/local-mcp.feature` drives the built `deyslide-mcp` over stdio like Claude Code does.

Some spec files use a lot of memory. If your machine runs short, limit the workers: `pnpm test --maxWorkers=2`.

### 4. Commit with Conventional Commits

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/). They become the release notes, so write them for users.

| Type | Use it for | Release effect |
| --- | --- | --- |
| `feat` | A new capability | Minor version |
| `fix` | A bug fix | Patch version |
| `perf` | A speed or memory improvement | Patch version |
| `docs` | Documentation only | None |
| `test` | Tests only | None |
| `refactor` | Code change with no behavior change | None |
| `build`, `ci`, `chore` | Tooling and maintenance | None |

Add `!` after the type, or a `BREAKING CHANGE:` footer, for breaking changes.

Example: `feat(scene3d): add a focus prop for architecture nodes`

### 5. Check your work

```bash
pnpm test
pnpm typecheck
pnpm build
```

All three must pass. When a change touches Rust code (`crates/` or `apps/native/src-tauri/`), also run:

```bash
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

The same checks run in CI on every pull request.

When a change touches the hosted MCP server's tools, guide or instructions (`apps/server/src/mcp/`), run `pnpm guide:sync` and commit what it changes in `crates/deyslide-core/src/`. The on-device server serves those copies, and scenarios fail when they drift.

When a change touches the web app or the API, also run `pnpm test:e2e`. It drives the built app in headless Chromium and is not part of CI, so it is on you to run it.

### 6. Open a pull request

- Fill in the pull request template.
- Link the issue with `Closes #<number>`.
- Use a Conventional Commit as the pull request title. Pull requests are squash merged, the title becomes the commit on `main`, and it is also the line users read in the release notes.
- Add the label that matches the change: `enhancement` for `feat`, `bug` for `fix`, `documentation` for `docs`.
- Keep one topic per pull request.

### 7. Review and merge

A maintainer reviews the change, may ask for updates, and squash merges it when it is ready.

## Releases

A maintainer releases by pushing a version tag from `main`:

```bash
git checkout main && git pull
git tag v0.1.0
git push origin v0.1.0
```

The tag must be a semantic version, such as `v1.2.3` or `v1.2.3-beta.1`. The Release workflow then creates a draft GitHub Release, builds the apps for Windows, macOS, Linux and Android with that version and attaches them with `latest.json` for updates. It also builds the iOS app, numbered with the version's first three parts (`1.2.3` for `v1.2.3-beta.1`), for TestFlight or, without an Apple account, for the simulator; that build never goes into the release. The release is published once every required build passed (iOS counts only when the Apple account is in the secrets). If one fails, the release stays a draft: run the failed job again, or publish it by hand. A tag with a pre-release part, such as `v1.2.3-beta.1`, is published as a pre-release, so the download page keeps offering the last stable version. The README's "Releases" section lists the files and the signing secrets.

GitHub writes the notes from the pull requests merged since the previous tag, grouped by label as set in `.github/release.yml`:

| Label | Heading |
| --- | --- |
| `enhancement` | Features |
| `bug` | Bug Fixes |
| `documentation` | Documentation |
| none or any other | Other Changes |

The tag is the version. There is no `CHANGELOG.md` to edit.

## Building and running the apps

The apps live in `apps/native` (Tauri 2) and show the web app built in mode `app`. From the repository root:

```bash
pnpm --filter @deyslide/native dev                 # the app with the web app's dev server (hot reload)
pnpm --filter @deyslide/native build               # installers for this system in target/release/bundle
pnpm --filter @deyslide/native build --no-bundle   # only the binary, target/release/deyslide
pnpm --filter @deyslide/native android:build --apk --target aarch64
```

Each builds the Motion Canvas animations and the web app (`pnpm --filter @deyslide/web build:app`) first. The app signs in to the public server unless `serverUrl` in its `settings.json` names another. [`apps/native/README.md`](apps/native/README.md) covers the Android setup and signing, the data folder, the MCP server for Claude Code and how to check slide previews.

## Project layout

The repository is a pnpm workspace. Run every command from the root.

| Path | Purpose |
| --- | --- |
| `apps/web/` | The web app: projects home page, the deck page with the Design canvas (`src/canvas/`) and the Markdown view (`src/editor/`), the live deck session (`src/deck/`), the sandboxed slide preview (`src/preview/`), presenting and export (`src/present/`), the assistant chat (`src/assistant/`), the layer that tells the website from the apps (`src/platform/`), sign in pages, guest storage in the browser |
| `apps/server/` | The API: Hono, Better Auth and Postgres through Kysely, live rooms (`src/collab/`), export jobs (`src/exports/`), the Claude deck assistant (`src/assistant/`), the MCP server for Claude Code (`src/mcp/`) and media uploads (`src/media/`), bundled into one file for production |
| `apps/renderer/` | Draws slides to PNG and records videos with the web app's preview in headless Chromium, for the MCP server and exports |
| `apps/native/` | The Deyslide app for Windows, macOS, Linux, Android and iOS (Tauri 2), and `deyslide mcp`, the MCP server for decks on a computer |
| `apps/deck/` | The demo deck (`slides.md`), its theme, and the video export script |
| `crates/deyslide-core/` | The Rust core the app and `deyslide-mcp` share: the library folder, Slidev slide splitting, the MCP tools and the render bridge |
| `packages/components/` | Slidev addon: public components in `components/`, logic and TresJS child components in `src/`, the shared UnoCSS preset |
| `packages/animations/` | Motion Canvas projects, built into `apps/deck/public/animations/` |
| `packages/deck-model/` | The deck format: Zod schema, Slidev Markdown conversion, the Yjs live document and how Markdown merges into it |
| `features/` | Gherkin features and their step definitions for every package |
| `e2e/` | Playwright end to end tests and the in-memory API they start, with a fake Claude |
| `scripts/` | `guide-sync.ts`, behind `pnpm guide:sync` |
| `deploy/` | Production Podman script (database, API, nginx, tunnel, renderer), nginx config and the renderer's Containerfile |
| `plugins/deyslide/`, `.claude-plugin/` | The Claude Code plugin (MCP server settings and the `deyslide` skill) and the marketplace that lists it |
| `patches/` | `pnpm patch` fixes for dependencies |

## Questions

Open an issue with the **Feature request** template if you are unsure whether an idea fits, or ask on an existing issue.
