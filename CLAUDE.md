# CLAUDE.md

Rules for Claude Code (and any other AI assistant) working in this repository.
Human contributors follow the same workflow, described in [CONTRIBUTING.md](CONTRIBUTING.md).

## Rules

### 1. No AI slop

- Never use the em dash character. Use a period, comma, colon or parentheses instead.
- Use correct grammar and real dictionary words.
- No slop gradients.
- No repetitive words. Do not reuse the same word or phrase within a sentence or across nearby sentences when a plain alternative exists.
- These rules apply to code comments, docs, commit messages, issues, pull requests and release notes.

### 2. No assumptions

- Do not assume anything, including generic or basic things.
- If the context is not clear, ask before acting.

### 3. Commit authorship

- Every commit uses the repository owner as author:
  - name: `bambanggunawanid`
  - email: `bambanggunawan887@gmail.com`
- Never add a `Co-Authored-By` trailer for Claude or Anthropic.
- Never add AI attribution trailers or footers to commits.

### 4. Open source workflow

This is an open source project (MIT). Every change follows the full contribution flow:

1. An issue exists first, opened from a template in `.github/ISSUE_TEMPLATE/`.
2. Work happens on a branch, never directly on `main`.
3. Commits follow [Conventional Commits](https://www.conventionalcommits.org/).
4. A pull request uses `.github/pull_request_template.md` and links its issue (`Closes #<number>`).
5. The pull request title is a Conventional Commit, because squash merges turn it into the commit on `main`.

### 5. Behavior driven development

- Every behavior change starts with a Gherkin scenario in `features/<name>.feature`.
- Step definitions live next to it in `features/<name>.spec.ts` and use `@amiceli/vitest-cucumber`.
- A change is done only when `pnpm test` passes.

### 6. Release notes

- A release is a pushed tag such as `v0.1.0`. The Release workflow then publishes a GitHub Release whose notes GitHub generates from the pull requests merged since the previous tag.
- Pull request titles become the release notes, so write them for users.
- Label each pull request (`enhancement`, `bug` or `documentation`) so it lands under the right heading. Unlabeled ones go under "Other Changes".

## Project map

| Path | Purpose |
| --- | --- |
| `apps/web/` | The web app: projects home page, project and deck pages, sign in pages, guest storage in the browser |
| `apps/server/` | The API: Hono, Better Auth and Postgres through Kysely, bundled into one file for production |
| `apps/deck/` | The demo deck (`slides.md`), its theme, and the video export script |
| `packages/components/` | Slidev addon: public components in `components/`, logic and TresJS child components in `src/`, the shared UnoCSS preset |
| `packages/animations/` | Motion Canvas projects, built into `apps/deck/public/animations/` |
| `packages/deck-model/` | The deck format: Zod schema, Slidev Markdown conversion, Yjs live document |
| `features/` | Gherkin features and their step definitions for every package |
| `e2e/` | Playwright end to end tests and the in-memory API they start |
| `deploy/` | Production Podman script (database, API, nginx, tunnel) and nginx config |

## Commands

| Command | What it does |
| --- | --- |
| `pnpm dev` | Builds animations, then starts Slidev with HMR |
| `pnpm dev:web` | Starts the web app with HMR |
| `pnpm dev:server` | Starts the API, restarting on changes. Needs Postgres, see the README |
| `pnpm build` | Builds animations, the deck in `apps/deck/dist/`, the web app in `apps/web/dist/` and the API in `apps/server/dist/` |
| `pnpm export` | Builds animations, then a PDF in `exports/deyslide.pdf` |
| `pnpm export:video` | Builds animations, then a WebM in `exports/deyslide.webm` |
| `pnpm animations:build` | Builds Motion Canvas projects only |
| `pnpm test` | Runs every BDD feature |
| `pnpm test:e2e` | Runs the Playwright tests in `e2e/` against the built web app and the API, local only |
| `pnpm typecheck` | Type checks the web app, the API, the deck and the animations |

Run `pnpm test`, `pnpm typecheck` and `pnpm build` before opening a pull request, and `pnpm test:e2e` when a change touches the web app or the API.
