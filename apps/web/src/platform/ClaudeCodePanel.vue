<script setup lang="ts">
import type { LibraryInfo, McpSetup } from './native'
import { onMounted, ref, shallowRef } from 'vue'
import { libraryInfo, librarySetRoot, mcpSetup } from './native'
import { apiBase } from './platform'

/**
 * How Claude Code on this computer reaches the decks: the command that adds
 * the app's own MCP server, the library folder it works in, and the hosted
 * server for the decks in the account. Computers only.
 */

const setup = shallowRef<McpSetup>()
const library = shallowRef<LibraryInfo>()
const libraryError = ref('')
const copied = ref<'local' | 'hosted'>()
const copyFailed = ref(false)
const changing = ref(false)

const hostedCommand = `claude mcp add --scope user --transport http deyslide ${apiBase()}/mcp`

/** The app's commands fail with a message already written for people. */
const messageOf = (error: unknown) => typeof error === 'string' ? error : error instanceof Error ? error.message : 'Something went wrong.'

onMounted(async () => {
  const [command, folder] = await Promise.allSettled([mcpSetup(), libraryInfo()])
  setup.value = command.status === 'fulfilled' ? command.value : { problem: messageOf(command.reason) }
  if (folder.status === 'fulfilled')
    library.value = folder.value
  else
    libraryError.value = messageOf(folder.reason)
})

/** Copies with the clipboard, or with the older copy command where the clipboard is not open to the page. */
async function writeClipboard(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  }
  catch {
    const field = document.createElement('textarea')
    field.value = text
    field.setAttribute('readonly', '')
    field.style.position = 'fixed'
    field.style.opacity = '0'
    document.body.append(field)
    field.select()
    try {
      return document.execCommand('copy')
    }
    catch {
      return false
    }
    finally {
      field.remove()
    }
  }
}

async function copy(which: 'local' | 'hosted', text: string) {
  copied.value = undefined
  copyFailed.value = !(await writeClipboard(text))
  if (!copyFailed.value)
    copied.value = which
}

async function changeFolder() {
  libraryError.value = ''
  const { open } = await import('@tauri-apps/plugin-dialog')
  const picked = await open({ directory: true, defaultPath: library.value?.root, title: 'Choose the Deyslide folder' })
  if (typeof picked !== 'string')
    return
  changing.value = true
  try {
    library.value = await librarySetRoot(picked)
  }
  catch (error) {
    libraryError.value = messageOf(error)
  }
  finally {
    changing.value = false
  }
}
</script>

<template>
  <section class="dey-panel mt-10 flex flex-col gap-3" data-testid="claude-code-panel">
    <h2 class="m-0 text-xl font-semibold">
      Connect Claude Code
    </h2>
    <p class="m-0 text-sm">
      Claude Code on this computer can create, read and edit the decks in your Deyslide folder, even offline. Run this command once in a terminal:
    </p>
    <template v-if="setup && 'command' in setup">
      <div class="flex items-start gap-2">
        <pre class="m-0 min-w-0 flex-1 overflow-x-auto rounded-md border border-dey-line p-3 text-sm" data-testid="mcp-command"><code>{{ setup.command }}</code></pre>
        <button class="dey-btn shrink-0 text-sm" data-testid="copy-mcp-command" @click="copy('local', setup.command)">
          {{ copied === 'local' ? 'Copied' : 'Copy' }}
        </button>
      </div>
      <p class="m-0 text-sm text-dey-muted">
        Keep Deyslide open while Claude Code works: the app draws the slide images Claude Code asks for.
      </p>
    </template>
    <p v-else-if="setup" class="m-0 text-sm text-rose-300" role="alert" data-testid="mcp-problem">
      {{ setup.problem }}
    </p>

    <div class="flex flex-wrap items-center gap-2 text-sm">
      <span>Decks are saved in</span>
      <code class="min-w-0 break-all rounded bg-slate-800 px-1.5 py-0.5" data-testid="library-root">{{ library?.root ?? '...' }}</code>
      <button class="dey-btn text-sm" :disabled="changing" data-testid="change-library" @click="changeFolder">
        Change
      </button>
    </div>
    <p v-if="libraryError" class="m-0 text-sm text-rose-300" role="alert" data-testid="library-error">
      {{ libraryError }}
    </p>

    <p class="m-0 text-sm">
      For the decks in your account, from any computer and without the app, add the hosted server instead. The first time Claude Code uses it, your browser opens to sign in.
    </p>
    <div class="flex items-start gap-2">
      <pre class="m-0 min-w-0 flex-1 overflow-x-auto rounded-md border border-dey-line p-3 text-sm" data-testid="hosted-command"><code>{{ hostedCommand }}</code></pre>
      <button class="dey-btn shrink-0 text-sm" data-testid="copy-hosted-command" @click="copy('hosted', hostedCommand)">
        {{ copied === 'hosted' ? 'Copied' : 'Copy' }}
      </button>
    </div>
    <p v-if="copyFailed" class="m-0 text-sm text-rose-300" role="alert">
      The clipboard is not available. Select the command and copy it yourself.
    </p>
  </section>
</template>
