#!/usr/bin/env node
// Writes latest.json, the file Tauri's updater reads to learn about a new
// version, from the files the computer builds made and their signatures:
//
//   node updater-manifest.mjs <folder> <tag> <owner/repo> <notes file> <out file>
//
// Each update file sits in <folder> next to its signature (<file>.sig,
// which the build makes when TAURI_SIGNING_PRIVATE_KEY is set). A platform
// whose file or signature is missing is left out. With no signed file at
// all, nothing is written: that release has no updates.
//
// The updater looks for `<os>-<arch>-<installer>` first, then `<os>-<arch>`,
// so an app installed from the MSI or the .deb gets the same kind again,
// and every other one the NSIS installer, the AppImage or the Mac app.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'

/** Update files by name, as the release workflow collects them. */
const FILES = [
  { pattern: /_x64-setup\.exe$/, platforms: ['windows-x86_64'] },
  { pattern: /_x64_[\w-]+\.msi$/, platforms: ['windows-x86_64-msi'] },
  // One app for Apple silicon and Intel Macs.
  { pattern: /_universal\.app\.tar\.gz$/, platforms: ['darwin-aarch64', 'darwin-x86_64'] },
  { pattern: /_amd64\.AppImage$/, platforms: ['linux-x86_64'] },
  { pattern: /_amd64\.deb$/, platforms: ['linux-x86_64-deb'] },
]

/**
 * The manifest for the files in `folder`, or undefined when none is signed.
 * `pubDate` is when the release is published, in RFC 3339.
 */
function updaterManifest({ folder, tag, repository, notes, pubDate }) {
  const names = readdirSync(folder).sort()
  const platforms = {}
  for (const { pattern, platforms: keys } of FILES) {
    const name = names.find(file => pattern.test(file))
    if (!name || !names.includes(`${name}.sig`))
      continue
    const signature = readFileSync(join(folder, `${name}.sig`), 'utf8').trim()
    const url = `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`
    for (const key of keys)
      platforms[key] = { signature, url }
  }
  if (Object.keys(platforms).length === 0)
    return undefined
  return { version: tag.replace(/^v/, ''), notes, pub_date: pubDate, platforms }
}

function main(args) {
  const [folder, tag, repository, notesFile, out] = args
  if (!folder || !tag || !repository || !notesFile || !out) {
    console.error('Usage: node updater-manifest.mjs <folder> <tag> <owner/repo> <notes file> <out file>')
    return 2
  }
  const notes = existsSync(notesFile) ? readFileSync(notesFile, 'utf8').trim() : ''
  const pubDate = process.env.PUB_DATE || new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  const manifest = updaterManifest({ folder, tag, repository, notes, pubDate })
  if (!manifest) {
    console.log('No update file is signed, so this release has no latest.json. Set TAURI_SIGNING_PRIVATE_KEY and TAURI_UPDATER_PUBKEY to sign them.')
    return 0
  }
  writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`)
  console.log(`latest.json lists ${Object.keys(manifest.platforms).join(', ')}`)
  return 0
}

process.exitCode = main(process.argv.slice(2))
