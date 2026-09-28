# Contributing to Deyslide

Thank you for helping. This guide covers the full path from an idea to a released change.
By taking part you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Requirements

- Node.js 24 (the version is pinned in `.node-version`)
- pnpm 10 (the exact version is pinned in `package.json` under `packageManager`)
- Chromium for `pnpm export` and `pnpm export:video`. Run `pnpm exec playwright install chromium` once.

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

All three must pass. The same checks run in CI on every pull request.

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

The Release workflow then publishes a GitHub Release. GitHub writes its notes from the pull requests merged since the previous tag, grouped by label as set in `.github/release.yml`:

| Label | Heading |
| --- | --- |
| `enhancement` | Features |
| `bug` | Bug Fixes |
| `documentation` | Documentation |
| none or any other | Other Changes |

The tag is the version. There is no `CHANGELOG.md` to edit.

## Project layout

The repository is a pnpm workspace. Run every command from the root.

| Path | Purpose |
| --- | --- |
| `apps/web/` | The web app: projects home page, project and deck pages, guest storage in the browser |
| `apps/deck/` | The demo deck (`slides.md`), its theme, and the video export script |
| `packages/components/` | Slidev addon: public components in `components/`, logic and TresJS child components in `src/`, the shared UnoCSS preset |
| `packages/animations/` | Motion Canvas projects, built into `apps/deck/public/animations/` |
| `packages/deck-model/` | The deck format: Zod schema, Slidev Markdown conversion, Yjs live document |
| `features/` | Gherkin features and their step definitions for every package |
| `deploy/` | Production Podman script and nginx config |

## Questions

Open an issue with the **Feature request** template if you are unsure whether an idea fits, or ask on an existing issue.
