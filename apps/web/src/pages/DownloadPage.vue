<script setup lang="ts">
import type { AppFile, LatestRelease } from '../platform/releases'
import { onMounted, shallowRef } from 'vue'
import { apiBase } from '../platform/platform'
import { latestRelease, RELEASES_PAGE } from '../platform/releases'

interface Platform {
  id: string
  name: string
  about: string
  /** Files for the main button, the first one the release has. */
  main: AppFile[]
  /** A second file, linked beside the button when the release has it. */
  other?: { file: AppFile, label: string }
}

const PLATFORMS: Platform[] = [
  { id: 'windows', name: 'Windows', about: 'For 64-bit Windows.', main: ['windows-setup', 'windows-msi'], other: { file: 'windows-msi', label: 'MSI package' } },
  { id: 'macos', name: 'macOS', about: 'One app for Apple silicon and Intel Macs.', main: ['macos'] },
  { id: 'linux', name: 'Linux', about: 'For 64-bit PCs, as an AppImage.', main: ['linux-appimage', 'linux-deb'], other: { file: 'linux-deb', label: '.deb package' } },
  { id: 'android', name: 'Android', about: 'An APK for phones and tablets.', main: ['android'] },
]

const release = shallowRef<LatestRelease>({ files: {} })
onMounted(async () => {
  release.value = await latestRelease()
})

/** The release's file for a platform, or the releases page when it has none. */
function mainLink(platform: Platform) {
  const file = platform.main.find(kind => release.value.files[kind])
  return file ? release.value.files[file]! : RELEASES_PAGE
}

/** The alternative file, when the release has it and the main link is a different file. */
function otherLink(platform: Platform) {
  const link = platform.other && release.value.files[platform.other.file]
  return link && link !== mainLink(platform) ? link : undefined
}

const LOCAL_COMMAND = 'claude mcp add --scope user deyslide-local -- "<path to Deyslide>" mcp'
// The server this page came from, which is the one Claude Code should use for the account.
const hostedCommand = `claude mcp add --scope user --transport http deyslide ${apiBase() || window.location.origin}/mcp`
</script>

<template>
  <section class="flex flex-col gap-8" data-testid="download-page">
    <div>
      <h1 class="m-0 text-2xl font-semibold">
        Get the Deyslide app
      </h1>
      <p class="mt-2 text-dey-muted">
        Keep decks as Markdown files on your computer or phone, present them full screen, and let Claude Code edit them. Sign in to open the decks in your account too.
      </p>
      <p v-if="release.version" class="m-0 text-sm text-dey-muted" data-testid="download-version">
        Latest version: {{ release.version }}
      </p>
    </div>

    <ul class="m-0 grid list-none gap-3 p-0 sm:grid-cols-2">
      <li v-for="platform in PLATFORMS" :key="platform.id" class="dey-panel flex flex-col gap-3">
        <div>
          <h2 class="m-0 text-lg font-medium">
            {{ platform.name }}
          </h2>
          <p class="m-0 mt-1 text-sm text-dey-muted">
            {{ platform.about }}
          </p>
        </div>
        <div class="mt-auto flex flex-wrap items-center gap-3">
          <a class="dey-btn-primary" :href="mainLink(platform)" :data-testid="`download-${platform.id}`">
            Download for {{ platform.name }}
          </a>
          <a
            v-if="otherLink(platform)"
            class="text-sm text-dey-accent"
            :href="otherLink(platform)"
            :data-testid="`download-${platform.other!.file}`"
          >
            {{ platform.other!.label }}
          </a>
        </div>
      </li>
    </ul>

    <p class="m-0 text-sm text-dey-muted">
      Every version is on the
      <a :href="RELEASES_PAGE" class="text-dey-accent" data-testid="releases-page">releases page</a>.
    </p>

    <div class="flex flex-col gap-2" data-testid="install-macos">
      <h2 class="m-0 text-xl font-semibold">
        Opening it on a Mac the first time
      </h2>
      <p class="m-0 text-sm">
        If macOS says it could not verify that Deyslide is free of malware:
      </p>
      <ol class="m-0 list-decimal space-y-1 pl-5 text-sm" data-testid="install-macos-steps">
        <li>Drag Deyslide from the disk image into Applications and start it from there. When the warning shows, choose Done.</li>
        <li>Go to System Settings, then Privacy &amp; Security.</li>
        <li>Under Security, click Open Anyway next to the line about Deyslide, and confirm with your password.</li>
      </ol>
      <p class="m-0 text-sm text-dey-muted">
        After that it starts like any other app.
      </p>
    </div>

    <div class="flex flex-col gap-2" data-testid="install-others">
      <h2 class="m-0 text-xl font-semibold">
        Windows, Linux and Android
      </h2>
      <ul class="m-0 list-disc space-y-1 pl-5 text-sm" data-testid="install-others-notes">
        <li>Windows: if SmartScreen warns about an unknown publisher, choose More info, then Run anyway.</li>
        <li>Linux: make the AppImage executable (<code>chmod +x</code>) and run it, or install the .deb package.</li>
        <li>Android: open the APK on the phone. When asked, allow your browser to install apps.</li>
      </ul>
    </div>

    <div class="flex flex-col gap-2" data-testid="claude-code-setup">
      <h2 class="m-0 text-xl font-semibold">
        Claude Code
      </h2>
      <p class="m-0 text-sm">
        On a computer, Claude Code can edit the decks in your Deyslide folder, even offline. The app shows the exact command under Connect Claude Code: copy it and run it in a terminal. It looks like this:
      </p>
      <pre class="m-0 overflow-x-auto rounded-md border border-dey-line p-3 text-sm" data-testid="local-command"><code>{{ LOCAL_COMMAND }}</code></pre>
      <p class="m-0 text-sm">
        For the decks in your Deyslide account, from any computer and without the app, add the hosted server instead. The first time Claude Code uses it, your browser opens to sign in.
      </p>
      <pre class="m-0 overflow-x-auto rounded-md border border-dey-line p-3 text-sm" data-testid="hosted-command"><code>{{ hostedCommand }}</code></pre>
    </div>
  </section>
</template>
