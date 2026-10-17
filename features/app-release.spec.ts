// @vitest-environment node
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber'
import { expect } from 'vitest'
import { deyslideMcp } from './support/local-mcp'

const feature = await loadFeature('./app-release.feature')

const script = fileURLToPath(new URL('../apps/native/scripts/app-version.sh', import.meta.url))

interface VersionRun {
  outputs: Record<string, string>
  config?: unknown
  error?: string
}

/** Runs the version script the way a workflow job does. */
function readVersion(env: Record<string, string>): VersionRun {
  const temp = mkdtempSync(join(tmpdir(), 'deyslide-version-'))
  const output = join(temp, 'output')
  try {
    execFileSync('bash', [script], {
      env: { ...process.env, ...env, RUNNER_TEMP: temp, GITHUB_OUTPUT: output },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const outputs = Object.fromEntries(
      readFileSync(output, 'utf8').trim().split('\n').map(line => line.split(/=(.*)/s).slice(0, 2)),
    ) as Record<string, string>
    return { outputs, config: JSON.parse(readFileSync(outputs.config!, 'utf8')) }
  }
  catch (error) {
    return { outputs: {}, error: String((error as { stderr?: Buffer }).stderr ?? error) }
  }
  finally {
    rmSync(temp, { recursive: true, force: true })
  }
}

const smokeScript = fileURLToPath(new URL('../apps/native/scripts/smoke-mcp.mjs', import.meta.url))

interface SmokeRun {
  ok: boolean
  output: string
}

/** Runs the release workflow's MCP check against an executable. */
function smokeCheck(executable: string): SmokeRun {
  try {
    const stdout = execFileSync(process.execPath, [smokeScript, executable], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 90_000 })
    return { ok: true, output: stdout }
  }
  catch (error) {
    const failed = error as { stdout?: string, stderr?: string }
    return { ok: false, output: `${failed.stdout ?? ''}${failed.stderr ?? ''}` }
  }
}

/** A stand-in for the app's executable: a shell script in a fresh folder. */
function fakeExecutable(body: string) {
  const temp = mkdtempSync(join(tmpdir(), 'deyslide-exe-'))
  const path = join(temp, 'deyslide')
  writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`)
  chmodSync(path, 0o755)
  return { path, remove: () => rmSync(temp, { recursive: true, force: true }) }
}

/** Each job's lines, by job name. */
function jobs(workflow: string) {
  const found: Record<string, string> = {}
  const body = workflow.slice(workflow.indexOf('\njobs:\n'))
  for (const part of body.split(/\n(?= {2}[\w-]+:\n)/).slice(1)) {
    const name = part.match(/^ {2}([\w-]+):/)![1]!
    found[name] = part
  }
  return found
}

const APP_JOBS = ['windows', 'macos', 'linux', 'android']

const root = fileURLToPath(new URL('..', import.meta.url))

/** Runs the release job's script with a stand-in `gh` and returns the arguments it got. */
function draftRelease(tag: string): string[] {
  const workflow = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8')
  const step = jobs(workflow).release!.match(/- name: Create a draft release with generated notes\n[\s\S]*?run: \|\n((?: {10}.*\n)+)/)![1]!
  const run = step.split('\n').map(line => line.slice(10)).join('\n')
  const temp = mkdtempSync(join(tmpdir(), 'deyslide-draft-'))
  try {
    const gh = join(temp, 'gh')
    writeFileSync(gh, `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${join(temp, 'args')}"\n`)
    chmodSync(gh, 0o755)
    execFileSync('bash', ['-e', '-c', run], {
      env: { ...process.env, PATH: `${temp}:${process.env.PATH}`, TAG: tag, GITHUB_REPOSITORY: 'owner/repo' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return readFileSync(join(temp, 'args'), 'utf8').trim().split('\n')
  }
  finally {
    rmSync(temp, { recursive: true, force: true })
  }
}

describeFeature(feature, ({ Scenario, ScenarioOutline }) => {
  ScenarioOutline('The tag sets the app version', ({ When, Then, And }, variables) => {
    let run: VersionRun
    When('the release workflow reads the version for the tag "<tag>"', () => {
      run = readVersion({ GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: variables.tag })
      expect(run.error).toBeUndefined()
    })
    Then('the apps are built as version "<version>"', () => {
      expect(run.outputs.version).toBe(variables.version)
      expect(run.config).toEqual({ version: variables.version })
    })
    And('Windows gets an MSI installer: <msi>', () => {
      expect(run.outputs.msi).toBe(variables.msi === 'yes' ? 'true' : 'false')
    })
  })

  ScenarioOutline('A tag that is no version stops the release before any build', ({ When, Then }, variables) => {
    let run: VersionRun
    When('the release workflow reads the version for the tag "<tag>"', () => {
      run = readVersion({ GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: variables.tag })
    })
    Then('it stops and says "<problem>"', () => {
      expect(run.error).toContain(variables.problem)
      expect(run.outputs).toEqual({})
    })
  })

  Scenario('A run by hand builds a version Android accepts', ({ When, Then }) => {
    let run: VersionRun
    When('the release workflow runs by hand as run 42', () => {
      run = readVersion({ GITHUB_REF_TYPE: 'branch', GITHUB_REF_NAME: 'main', GITHUB_RUN_NUMBER: '42' })
    })
    Then('the apps are built as version "0.0.42"', () => {
      expect(run.outputs).toMatchObject({ version: '0.0.42', msi: 'true' })
    })
  })

  Scenario('The release waits as a draft until every installer is attached', ({ Given, Then, And }) => {
    let workflow: string
    let byName: Record<string, string>
    Given('the Release workflow', () => {
      workflow = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8')
      byName = jobs(workflow)
      expect(Object.keys(byName)).toEqual(['release', ...APP_JOBS, 'publish'])
    })
    Then('the release is created as a draft', () => {
      expect(byName.release).toMatch(/gh release create .*--draft/)
    })
    And('only the jobs that write to the release may write to the repository', () => {
      expect(workflow).toMatch(/\npermissions:\n {2}contents: read\n/)
      for (const [name, job] of Object.entries(byName))
        expect(job.includes('contents: write'), name).toBe(name === 'release' || name === 'publish')
    })
    And('the app jobs keep no credentials in their checkout', () => {
      for (const name of APP_JOBS) {
        expect(byName[name], name).toMatch(/actions\/checkout@\S+\n\s+with:\n\s+persist-credentials: false/)
        expect(byName[name], name).not.toContain('gh release')
      }
    })
    And('the publish job attaches what the Windows, macOS, Linux and Android jobs built', () => {
      expect(byName.publish).toContain('needs: [release, windows, macos, linux, android]')
      for (const name of APP_JOBS)
        expect(byName[name], name).toContain(`name: deyslide-${name}`)
      expect(byName.publish).toContain('pattern: deyslide-*')
      expect(byName.publish).toContain('gh release upload "$TAG"')
    })
    And('it publishes the release only when all four builds passed', () => {
      const publish = byName.publish!.match(/- name: Publish the release\n\s+if: (.*)\n\s+run: (.*)/)!
      expect(publish[1]).toBe(APP_JOBS.map(name => `needs.${name}.result == 'success'`).join(' && '))
      expect(publish[2]).toContain('gh release edit "$TAG"')
      expect(publish[2]).toContain('--draft=false')
    })
  })

  Scenario('Signing secrets reach the builds as they are', ({ Given, Then, And }) => {
    let workflow: string
    Given('the Release workflow', () => {
      workflow = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8')
    })
    Then('no secret is written to a file the runner reads back', () => {
      // A line in $GITHUB_ENV holds one line of text, and a properties file reads escapes.
      const secrets = [...workflow.matchAll(/(\w+): \$\{\{ secrets\.\w+ \}\}/g)].map(match => match[1]!)
      expect(secrets.length).toBeGreaterThan(0)
      for (const line of workflow.split('\n').filter(line => line.includes('GITHUB_ENV'))) {
        expect(line).not.toContain('${!')
        for (const secret of secrets)
          expect(line).not.toMatch(new RegExp(`\\$\\{?${secret}\\b`))
      }
      expect(workflow).not.toContain('keystore.properties')
    })
    And('the Android build reads its signing key from variables', () => {
      const build = jobs(workflow).android!.match(/- name: Build the APK\n\s+env:\n((?:\s+\w+: .*\n)+)/)![1]!
      for (const variable of ['ANDROID_KEYSTORE_FILE', 'ANDROID_STORE_PASSWORD', 'ANDROID_KEY_ALIAS', 'ANDROID_KEY_PASSWORD'])
        expect(build).toMatch(new RegExp(`${variable}: \\$\\{\\{`))
      const gradle = readFileSync(new URL('../apps/native/src-tauri/gen/android/app/build.gradle.kts', import.meta.url), 'utf8')
      expect(gradle).toContain('System.getenv(variable)')
      for (const variable of ['ANDROID_KEYSTORE_FILE', 'ANDROID_STORE_PASSWORD', 'ANDROID_KEY_ALIAS', 'ANDROID_KEY_PASSWORD'])
        expect(gradle).toContain(`"${variable}"`)
    })
  })

  ScenarioOutline('A pre-release tag never becomes the latest release', ({ When, Then }, variables) => {
    let args: string[]
    When('the release job drafts the release for the tag "<tag>"', () => {
      args = draftRelease(variables.tag)
      expect(args.slice(0, 3)).toEqual(['release', 'create', variables.tag])
      expect(args).toContain('--draft')
    })
    Then('the draft is marked as a pre-release: <prerelease>', () => {
      expect(args.includes('--prerelease')).toBe(variables.prerelease === 'yes')
    })
  })

  Scenario('Scripts keep Unix line endings on Windows runners', ({ Given, Then }) => {
    let checkedOut: string
    Given('a checkout that turns line endings into Windows ones, as Git for Windows does by default', () => {
      const temp = execFileSync('git', ['-c', 'core.autocrlf=true', 'checkout-index', '--temp', '--', 'apps/native/scripts/app-version.sh'], { cwd: root, encoding: 'utf8' }).split('\t')[0]!
      const path = join(root, temp)
      try {
        checkedOut = readFileSync(path, 'utf8')
      }
      finally {
        rmSync(path, { force: true })
      }
    })
    Then('the version script still has Unix line endings', () => {
      expect(checkedOut).toContain('set -euo pipefail\n')
      expect(checkedOut).not.toContain('\r')
    })
  })

  Scenario('Each computer build checks the MCP server before it is uploaded', ({ Given, Then, And }) => {
    let byName: Record<string, string>
    const computers = ['windows', 'macos', 'linux']
    Given('the Release workflow', () => {
      byName = jobs(readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8'))
    })
    Then('the Windows, macOS and Linux jobs start the executable they built as "deyslide mcp"', () => {
      for (const name of computers) {
        const step = byName[name]!.split('\n      - ').find(part => part.startsWith('name: Check the MCP server'))
        expect(step, name).toContain('node apps/native/scripts/smoke-mcp.mjs')
      }
    })
    And('they do it before collecting the installers', () => {
      for (const name of computers) {
        const job = byName[name]!
        expect(job.indexOf('- name: Check the MCP server'), name).toBeGreaterThan(job.indexOf('tauri build'))
        expect(job.indexOf('- name: Check the MCP server'), name).toBeLessThan(job.indexOf('- name: Collect'))
      }
    })
  })

  Scenario('The MCP check passes a working server', ({ Given, When, Then }) => {
    let executable: ReturnType<typeof fakeExecutable>
    let run: SmokeRun
    Given('an executable that runs the on-device MCP server as "deyslide mcp"', () => {
      // The app's executable takes "mcp" first; deyslide-mcp is the same server without it.
      executable = fakeExecutable(`[ "$1" = mcp ] || exit 64\nshift\nexec ${JSON.stringify(deyslideMcp())} "$@"`)
    })
    When('the release workflow checks it', () => {
      try {
        run = smokeCheck(executable.path)
      }
      finally {
        executable.remove()
      }
    })
    Then('the check passes after it lists the tools and writes a deck to the library folder', () => {
      expect(run.ok, run.output).toBe(true)
      expect(run.output).toContain('Tools: create_deck, create_project, edit_slides, get_guide, list_decks, read_deck, render_slides, write_deck')
      expect(run.output).toMatch(/Library: .*Hello\.md/)
      expect(run.output).toContain('The MCP server works.')
    })
  })

  Scenario('The MCP check stops a build whose server does not answer', ({ Given, When, Then }) => {
    let executable: ReturnType<typeof fakeExecutable>
    let run: SmokeRun
    Given('an executable that stops as soon as it starts', () => {
      executable = fakeExecutable('exit 3')
    })
    When('the release workflow checks it', () => {
      try {
        run = smokeCheck(executable.path)
      }
      finally {
        executable.remove()
      }
    })
    Then('the check fails and says "The server stopped before the check finished"', () => {
      expect(run.ok).toBe(false)
      expect(run.output).toContain('The server stopped before the check finished (exit code 3).')
    })
  })
})
