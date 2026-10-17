// @vitest-environment node
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber'
import { expect } from 'vitest'
import { deyslideMcp } from './support/local-mcp'

const feature = await loadFeature('./app-release.feature')

const script = fileURLToPath(new URL('../apps/native/scripts/app-version.sh', import.meta.url))
const manifestScript = fileURLToPath(new URL('../apps/native/scripts/updater-manifest.mjs', import.meta.url))
const iosSettingsScript = fileURLToPath(new URL('../apps/native/scripts/ios-settings.py', import.meta.url))

/** Where the apps ask for the newest version. */
const LATEST_JSON = 'https://github.com/bambanggunawanid/deyslide/releases/latest/download/latest.json'

interface VersionRun {
  outputs: Record<string, string>
  config?: unknown
  /** What the script printed, such as its warnings. */
  log?: string
  error?: string
}

/** Runs the version script the way a workflow job does. */
function readVersion(env: Record<string, string>): VersionRun {
  const temp = mkdtempSync(join(tmpdir(), 'deyslide-version-'))
  const output = join(temp, 'output')
  try {
    const log = execFileSync('bash', [script], {
      // The updater keys come from the job, never from the machine running the specs.
      env: { ...process.env, TAURI_UPDATER_PUBKEY: '', SIGNS_UPDATES: '', ...env, RUNNER_TEMP: temp, GITHUB_OUTPUT: output },
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    })
    const outputs = Object.fromEntries(
      readFileSync(output, 'utf8').trim().split('\n').map(line => line.split(/=(.*)/s).slice(0, 2)),
    ) as Record<string, string>
    return { outputs, config: JSON.parse(readFileSync(outputs.config!, 'utf8')), log }
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
const COMPUTER_JOBS = ['windows', 'macos', 'linux']

/** The Apple account a signed iOS build needs, as one expression over the secrets. */
const APPLE_ACCOUNT = ['APPLE_CERTIFICATE', 'APPLE_PROVISIONING_PROFILE', 'APPLE_API_ISSUER', 'APPLE_API_KEY_ID', 'APPLE_API_KEY', 'APPLE_TEAM_ID']
  .map(name => `secrets.${name} != ''`)
  .join(' && ')

/** A step of a job by its name: its lines up to the next step. */
function step(job: string, name: string) {
  const start = job.indexOf(`- name: ${name}\n`)
  expect(start, `no step "${name}"`).toBeGreaterThanOrEqual(0)
  const rest = job.slice(start + 1)
  const end = rest.search(/\n {6}- /)
  return end === -1 ? rest : rest.slice(0, end)
}

/** The files the computer jobs collect for a release, by the names Tauri gives them. */
function computerFiles(tag: string) {
  const version = tag.replace(/^v/, '')
  return [
    `Deyslide_${version}_x64-setup.exe`,
    `Deyslide_${version}_x64_en-US.msi`,
    `Deyslide_${version}_universal.dmg`,
    `Deyslide_${version}_universal.app.tar.gz`,
    `Deyslide_${version}_amd64.AppImage`,
    `Deyslide_${version}_amd64.deb`,
    `Deyslide_${version}_android.apk`,
  ]
}

/** The signature the build would write next to a file: different for each one. */
const signatureOf = (name: string) => Buffer.from(`untrusted comment: signature from tauri secret key\n${name}`).toString('base64')

interface ManifestRun {
  manifest?: { version: string, notes: string, pub_date: string, platforms: Record<string, { signature: string, url: string }> }
  log: string
}

/** Runs the publish job's latest.json script on a folder of files. */
function writeManifest(folder: string, tag: string, notes: string): ManifestRun {
  const notesFile = join(folder, '..', 'notes.md')
  writeFileSync(notesFile, `${notes}\n`)
  const out = join(folder, 'latest.json')
  const log = execFileSync('node', [manifestScript, folder, tag, 'bambanggunawanid/deyslide', notesFile, out], { encoding: 'utf8', env: { ...process.env, PUB_DATE: '2026-10-17T09:00:00Z' } })
  return { manifest: existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : undefined, log }
}

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
      expect(Object.keys(byName)).toEqual(['release', ...APP_JOBS, 'ios', 'publish'])
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
      for (const name of [...APP_JOBS, 'ios']) {
        expect(byName[name], name).toMatch(/actions\/checkout@\S+\n\s+with:\n\s+persist-credentials: false/)
        expect(byName[name], name).not.toContain('gh release')
      }
    })
    And('the publish job attaches what the Windows, macOS, Linux and Android jobs built', () => {
      expect(byName.publish).toContain('needs: [release, windows, macos, linux, android, ios]')
      for (const name of APP_JOBS)
        expect(byName[name], name).toContain(`name: deyslide-${name}`)
      expect(byName.publish).toContain('pattern: deyslide-*')
      expect(byName.publish).toContain('gh release upload "$TAG"')
    })
    And('it publishes the release only when those four builds passed, and the iOS build too when the Apple account is set', () => {
      const publish = byName.publish!.match(/- name: Publish the release\n\s+if: (.*)\n\s+run: (.*)/)!
      expect(publish[1]).toBe(`${APP_JOBS.map(name => `needs.${name}.result == 'success'`).join(' && ')} && (env.IOS_REQUIRED != 'true' || needs.ios.result == 'success')`)
      expect(publish[2]).toContain('gh release edit "$TAG"')
      expect(publish[2]).toContain('--draft=false')
      // Exactly when it does not publish, it says why the release stays a draft.
      const draft = byName.publish!.match(/- name: Keep the release a draft\n\s+if: (.*)\n/)!
      expect(draft[1]).toBe(`${APP_JOBS.map(name => `needs.${name}.result != 'success'`).join(' || ')} || (env.IOS_REQUIRED == 'true' && needs.ios.result != 'success')`)
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

  Scenario('The iOS build goes to TestFlight, never into the release', ({ Given, Then, And }) => {
    let ios: string
    let publish: string
    Given('the Release workflow', () => {
      const byName = jobs(readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8'))
      ios = byName.ios!
      publish = byName.publish!
    })
    Then('the iOS job signs its build only when the whole Apple account is in the secrets', () => {
      expect(step(ios, 'Use the Apple account when it is set')).toContain(`SIGNED: \${{ ${APPLE_ACCOUNT} }}`)
      const build = step(ios, 'Build the app')
      expect(build).toContain('--export-method app-store-connect')
      expect(build).toMatch(/else\n\s+unset APPLE_DEVELOPMENT_TEAM IOS_CERTIFICATE IOS_CERTIFICATE_PASSWORD IOS_MOBILE_PROVISION\n\s+.*tauri ios build --target aarch64-sim/)
    })
    And('the publish job requires the iOS build by that same rule', () => {
      expect(publish).toContain(`IOS_REQUIRED: \${{ ${APPLE_ACCOUNT} }}`)
    })
    And('the iOS files are named unlike the ones the publish job attaches', () => {
      for (const [, name] of ios.matchAll(/upload-artifact@\S+\n\s+with:\n\s+name: (\S+)/g))
        expect(name).not.toMatch(/^deyslide-/)
      expect(publish).toContain('pattern: deyslide-*')
    })
    And('the iOS job uploads the Xcode project it used as "ios-project"', () => {
      expect(ios).toMatch(/name: ios-project\n\s+path: apps\/native\/src-tauri\/gen\/apple\n/)
      // After the project exists and has the app's settings, before the build changes it.
      const order = ['- name: Create the Xcode project when it is missing', '- name: Apply the app\'s iOS settings', 'name: ios-project', '- name: Build the app'].map(text => ios.indexOf(text))
      expect(order.every(index => index >= 0)).toBe(true)
      expect([...order].sort((a, b) => a - b)).toEqual(order)
      expect(step(ios, 'Create the Xcode project when it is missing')).toContain('if [ -d src-tauri/gen/apple ]')
    })
    And('it uploads to TestFlight for a pushed tag only', () => {
      const upload = step(ios, 'Upload the build to TestFlight')
      expect(upload).toContain('if: steps.signing.outputs.signed == \'true\' && github.event_name == \'push\'')
      expect(upload).toContain('xcrun altool --upload-app --type ios')
    })
  })

  Scenario('Computer builds sign their update files and the release lists them', ({ Given, Then, And }) => {
    let byName: Record<string, string>
    Given('the Release workflow', () => {
      byName = jobs(readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8'))
    })
    Then('the Windows, macOS and Linux version steps get the updater key from the variable "TAURI_UPDATER_PUBKEY"', () => {
      for (const name of COMPUTER_JOBS) {
        const version = step(byName[name]!, 'Read the version from the tag')
        expect(version, name).toContain('TAURI_UPDATER_PUBKEY: ${{ vars.TAURI_UPDATER_PUBKEY }}')
        // The step learns whether the signing key is set, never the key.
        expect(version, name).toContain('SIGNS_UPDATES: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY != \'\' }}')
      }
      for (const name of ['android', 'ios'])
        expect(step(byName[name]!, 'Read the version from the tag'), name).not.toContain('TAURI_UPDATER_PUBKEY')
    })
    And('their builds get the signing key from the secrets only when updates are on', () => {
      const builds = { windows: 'Build the installers', macos: 'Build the app', linux: 'Build the AppImage and the .deb' }
      for (const [name, title] of Object.entries(builds)) {
        const build = step(byName[name]!, title)
        expect(build, name).toContain('TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}')
        expect(build, name).toContain('TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}')
        expect(build, name).toContain('UPDATES: ${{ steps.version.outputs.updates }}')
        expect(build, name).toContain('if [ "$UPDATES" != true ]; then unset TAURI_SIGNING_PRIVATE_KEY TAURI_SIGNING_PRIVATE_KEY_PASSWORD; fi')
      }
    })
    And('they collect each update file\'s signature', () => {
      expect(step(byName.windows!, 'Collect the installers')).toContain('*-setup.exe.sig')
      expect(step(byName.windows!, 'Collect the installers')).toContain('*.msi.sig')
      expect(step(byName.macos!, 'Collect the disk image')).toContain('"out/Deyslide_${VERSION}_universal.app.tar.gz.sig"')
      expect(step(byName.linux!, 'Collect the packages')).toContain('*.AppImage.sig')
      expect(step(byName.linux!, 'Collect the packages')).toContain('*.deb.sig')
    })
    And('the publish job writes latest.json before it attaches the files', () => {
      const publish = byName.publish!
      const write = step(publish, 'Write latest.json for updates')
      expect(write).toContain('node apps/native/scripts/updater-manifest.mjs out "$TAG" "$GITHUB_REPOSITORY" "$RUNNER_TEMP/notes.md" out/latest.json')
      expect(publish.indexOf('- name: Write latest.json for updates')).toBeLessThan(publish.indexOf('- name: Attach the installers'))
      expect(publish).toMatch(/actions\/checkout@\S+\n\s+with:\n\s+persist-credentials: false\n\s+sparse-checkout: apps\/native\/scripts\n/)
    })
  })

  ScenarioOutline('iOS builds the version without its pre-release', ({ When, Then }, variables) => {
    let run: VersionRun
    When('the release workflow reads the version for the tag "<tag>"', () => {
      run = readVersion({ GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: variables.tag })
      expect(run.error).toBeUndefined()
    })
    Then('iOS builds version "<core>"', () => {
      expect(run.outputs.core).toBe(variables.core)
    })
  })

  Scenario('The updater key turns updates on in a computer build', ({ When, Then, And }) => {
    let run: VersionRun
    When('the release workflow reads the version for the tag "v1.2.3" with the updater key "dW50cnVzdGVkIGNvbW1lbnQ=" and the signing key set', () => {
      // A key pasted with its line break still counts.
      run = readVersion({ GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: 'v1.2.3', TAURI_UPDATER_PUBKEY: 'dW50cnVzdGVkIGNvbW1lbnQ=\n', SIGNS_UPDATES: 'true' })
      expect(run.error).toBeUndefined()
    })
    Then(`the apps are built as version "1.2.3" with updates from "${LATEST_JSON}" checked against "dW50cnVzdGVkIGNvbW1lbnQ="`, () => {
      expect(run.outputs).toMatchObject({ version: '1.2.3', updates: 'true' })
      expect(run.config).toMatchObject({ version: '1.2.3', plugins: { updater: { pubkey: 'dW50cnVzdGVkIGNvbW1lbnQ=', endpoints: [LATEST_JSON] } } })
    })
    And('the build makes signed update files', () => {
      expect(run.config).toMatchObject({ bundle: { createUpdaterArtifacts: true } })
    })
  })

  /** The updater keys a job passes, by the words the scenarios use. */
  const KEYS: Record<string, Record<string, string>> = {
    'no updater key at all': {},
    'the updater key "dW50cnVzdGVkIGNvbW1lbnQ=" only': { TAURI_UPDATER_PUBKEY: 'dW50cnVzdGVkIGNvbW1lbnQ=', SIGNS_UPDATES: 'false' },
    'the signing key only': { SIGNS_UPDATES: 'true' },
  }

  ScenarioOutline('Without both halves of the updater key a build has no updates', ({ When, Then, And }, variables) => {
    let run: VersionRun
    When('the release workflow reads the version for the tag "v1.2.3" with <keys>', () => {
      run = readVersion({ GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: 'v1.2.3', ...KEYS[variables.keys] })
      expect(run.error).toBeUndefined()
    })
    Then('the apps are built as version "1.2.3" with no updates', () => {
      expect(run.outputs).toMatchObject({ version: '1.2.3', updates: 'false' })
      expect(run.config).toEqual({ version: '1.2.3' })
    })
    And('the workflow warns "<warning>"', () => {
      const warnings = run.log!.split('\n').filter(line => line.startsWith('::warning::'))
      expect(warnings).toEqual(variables.warning === 'nothing' ? [] : [`::warning::${variables.warning}`])
    })
  })

  Scenario('An updater key that is no key stops the release before any build', ({ When, Then }) => {
    let run: VersionRun
    When('the release workflow reads the version for the tag "v1.2.3" with the updater key "not a key" and the signing key set', () => {
      run = readVersion({ GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: 'v1.2.3', TAURI_UPDATER_PUBKEY: 'not a key!', SIGNS_UPDATES: 'true' })
    })
    Then('it stops and says "TAURI_UPDATER_PUBKEY is not an updater public key."', () => {
      expect(run.error).toContain('TAURI_UPDATER_PUBKEY is not an updater public key.')
      expect(run.outputs).toEqual({})
    })
  })

  /** A folder of built files, as the publish job downloads them. */
  function builtFiles(tag: string, { signed = true, unsigned = [] as string[] } = {}) {
    const temp = mkdtempSync(join(tmpdir(), 'deyslide-files-'))
    const folder = join(temp, 'out')
    execFileSync('mkdir', [folder])
    for (const name of computerFiles(tag)) {
      writeFileSync(join(folder, name), name)
      // Tauri signs update files only; the disk image and the APK have none.
      const update = !/\.(?:dmg|apk)$/.test(name)
      if (signed && update && !unsigned.some(suffix => name.endsWith(suffix)))
        writeFileSync(join(folder, `${name}.sig`), `${signatureOf(name)}\n`)
    }
    return { temp, folder }
  }

  Scenario('latest.json lists a signed file for each computer', ({ Given, When, Then, And }) => {
    let files: ReturnType<typeof builtFiles>
    let run: ManifestRun
    Given('the files the computer builds made for "v0.3.0", each with its signature', () => {
      files = builtFiles('v0.3.0')
    })
    When('the publish job writes latest.json with the notes "Faster canvas"', () => {
      try {
        run = writeManifest(files.folder, 'v0.3.0', 'Faster canvas')
      }
      finally {
        rmSync(files.temp, { recursive: true, force: true })
      }
    })
    Then('latest.json says version "0.3.0" with the notes "Faster canvas" and the publish date', () => {
      expect(run.manifest).toMatchObject({ version: '0.3.0', notes: 'Faster canvas', pub_date: '2026-10-17T09:00:00Z' })
    })
    And('it lists these files', (_, table: { platform: string, file: string }[]) => {
      expect(Object.keys(run.manifest!.platforms).sort()).toEqual(table.map(row => row.platform).sort())
      for (const row of table)
        expect(run.manifest!.platforms[row.platform]!.url, row.platform).toMatch(new RegExp(`/${row.file.replace(/\./g, '\\.')}$`))
    })
    And('each one carries the text of its file\'s signature and the file\'s link in the release', () => {
      for (const { signature, url } of Object.values(run.manifest!.platforms)) {
        const name = url.split('/').at(-1)!
        expect(url).toBe(`https://github.com/bambanggunawanid/deyslide/releases/download/v0.3.0/${name}`)
        expect(signature).toBe(signatureOf(name))
      }
    })
  })

  Scenario('A file without a signature is left out of latest.json', ({ Given, But, When, Then, And }) => {
    let files: ReturnType<typeof builtFiles>
    let run: ManifestRun
    Given('the files the computer builds made for "v0.3.0", each with its signature', () => {
      files = builtFiles('v0.3.0', { unsigned: ['.deb'] })
    })
    But('the .deb has no signature', () => {
      expect(existsSync(join(files.folder, 'Deyslide_0.3.0_amd64.deb.sig'))).toBe(false)
    })
    When('the publish job writes latest.json with the notes "Faster canvas"', () => {
      try {
        run = writeManifest(files.folder, 'v0.3.0', 'Faster canvas')
      }
      finally {
        rmSync(files.temp, { recursive: true, force: true })
      }
    })
    Then('latest.json has no "linux-x86_64-deb"', () => {
      expect(run.manifest!.platforms).not.toHaveProperty('linux-x86_64-deb')
    })
    And('it still lists "linux-x86_64"', () => {
      expect(run.manifest!.platforms['linux-x86_64']!.url).toMatch(/\/Deyslide_0\.3\.0_amd64\.AppImage$/)
    })
  })

  Scenario('A release without signed files has no latest.json', ({ Given, When, Then, And }) => {
    let files: ReturnType<typeof builtFiles>
    let run: ManifestRun
    Given('the files the computer builds made for "v0.3.0", without signatures', () => {
      files = builtFiles('v0.3.0', { signed: false })
    })
    When('the publish job writes latest.json with the notes "Faster canvas"', () => {
      try {
        run = writeManifest(files.folder, 'v0.3.0', 'Faster canvas')
      }
      finally {
        rmSync(files.temp, { recursive: true, force: true })
      }
    })
    Then('no latest.json is written', () => {
      expect(run.manifest).toBeUndefined()
    })
    And('the job says "No update file is signed, so this release has no latest.json."', () => {
      expect(run.log).toContain('No update file is signed, so this release has no latest.json.')
    })
  })

  Scenario('The Xcode project gets the app\'s link scheme and settings', ({ Given, When, Then, And }) => {
    let temp: string
    let plist: string
    let info: string
    Given('an Info.plist from Tauri\'s iOS template with a link scheme of another app', () => {
      temp = mkdtempSync(join(tmpdir(), 'deyslide-plist-'))
      plist = join(temp, 'Info.plist')
      writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key>
  <string>$(EXECUTABLE_NAME)</string>
  <key>CFBundleURLTypes</key>
  <array>
    <dict>
      <key>CFBundleURLName</key>
      <string>com.example.other</string>
      <key>CFBundleURLSchemes</key>
      <array><string>com.example.other</string></array>
    </dict>
  </array>
  <key>UISupportedInterfaceOrientations</key>
  <array><string>UIInterfaceOrientationPortrait</string></array>
</dict>
</plist>
`)
    })
    When('the iOS job applies the app\'s settings twice', () => {
      try {
        for (let time = 0; time < 2; time++)
          execFileSync('python3', ['-I', iosSettingsScript, plist], { stdio: ['ignore', 'pipe', 'pipe'] })
        info = readFileSync(plist, 'utf8')
      }
      finally {
        rmSync(temp, { recursive: true, force: true })
      }
    })
    Then('the Info.plist lists the link schemes "com.example.other" and "id.bambanggunawan.deyslide", each once', () => {
      const urlTypes = info.slice(info.indexOf('<key>CFBundleURLTypes</key>'), info.indexOf('</array>\n\t<key>', info.indexOf('<key>CFBundleURLTypes</key>')))
      const schemes = [...urlTypes.matchAll(/<key>CFBundleURLSchemes<\/key>\s*<array>\s*<string>([^<]+)<\/string>/g)].map(match => match[1])
      expect(schemes).toEqual(['com.example.other', 'id.bambanggunawan.deyslide'])
      // What Tauri wrote stays.
      expect(info).toContain('<string>$(EXECUTABLE_NAME)</string>')
    })
    And('the app is named "Deyslide" under its icon', () => {
      expect(info).toMatch(/<key>CFBundleDisplayName<\/key>\s*<string>Deyslide<\/string>/)
    })
    And('it says it uses no encryption of its own', () => {
      expect(info).toMatch(/<key>ITSAppUsesNonExemptEncryption<\/key>\s*<false\/>/)
    })
    And('an iPad shows it in every orientation', () => {
      const ipad = info.slice(info.indexOf('<key>UISupportedInterfaceOrientations~ipad</key>'))
      const list = ipad.slice(0, ipad.indexOf('</array>'))
      for (const orientation of ['Portrait', 'PortraitUpsideDown', 'LandscapeLeft', 'LandscapeRight'])
        expect(list).toContain(`<string>UIInterfaceOrientation${orientation}</string>`)
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
