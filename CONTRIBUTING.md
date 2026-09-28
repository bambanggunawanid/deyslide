# Contributing to Deyslide

Thank you for helping. This guide covers the full path from an idea to a released change.
By taking part you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Requirements

- Node.js 22.18 or newer
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

Logic that needs no browser lives in plain TypeScript under `src/` so the scenarios stay fast.
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
- Use a Conventional Commit as the pull request title. Pull requests are squash merged, and the title becomes the commit on `main`.
- Keep one topic per pull request.

### 7. Review and merge

A maintainer reviews the change, may ask for updates, and squash merges it when it is ready.

## Releases

Releases are automated with [release-please](https://github.com/googleapis/release-please):

1. Each merge to `main` updates an open release pull request.
2. That pull request bumps the version and writes `CHANGELOG.md` from the Conventional Commits since the last release.
3. When a maintainer merges it, release-please tags the version and publishes a GitHub Release with the same notes.

Do not edit `CHANGELOG.md` or the `version` field in `package.json` by hand.

## Project layout

| Path | Purpose |
| --- | --- |
| `slides.md` | Demo deck |
| `components/` | Public components, auto imported by Slidev |
| `src/` | Internal logic and TresJS child components |
| `animations/` | Motion Canvas project, built into `public/animations/` |
| `features/` | Gherkin features and step definitions |
| `scripts/` | Video export |
| `deploy/` | Production Docker Compose stack and nginx config |

## Questions

Open an issue with the **Feature request** template if you are unsure whether an idea fits, or ask on an existing issue.
