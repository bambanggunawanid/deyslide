<script setup lang="ts">
import type { SharedRole } from '../guest/types'
import type { ListEntry, SharingApi, ShareList, ShareTarget } from '../projects/sharing'
import { DialogClose, DialogContent, DialogDescription, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from 'reka-ui'
import { computed, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useAccount } from '../composables/useAccount'

/**
 * Who has access to a project or deck. Owners and editors add people by
 * email; the owner changes roles and removes people; anyone else can leave.
 */
const props = defineProps<{
  target: ShareTarget
  /** The project's or deck's name, for the title. */
  name: string
  sharing: SharingApi
}>()
const open = defineModel<boolean>('open', { required: true })

const { account } = useAccount()
const router = useRouter()
const list = ref<ShareList>()
const email = ref('')
const role = ref<SharedRole>('viewer')
const busy = ref(false)
const error = ref('')
const loadError = ref('')

const isOwner = computed(() => list.value?.role === 'owner')
const canShare = computed(() => list.value?.role === 'owner' || list.value?.role === 'editor')
const noun = computed(() => props.target.type === 'project' ? 'project' : 'deck')

async function load() {
  loadError.value = ''
  try {
    list.value = await props.sharing.members(props.target)
  }
  catch (caught) {
    loadError.value = caught instanceof Error ? caught.message : String(caught)
  }
}

watch(open, (value) => {
  if (value) {
    email.value = ''
    error.value = ''
    void load()
  }
}, { immediate: true })

async function run(action: () => Promise<unknown>) {
  busy.value = true
  error.value = ''
  try {
    await action()
    return true
  }
  catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught)
    return false
  }
  finally {
    busy.value = false
  }
}

async function share() {
  await run(async () => {
    list.value = await props.sharing.share(props.target, email.value.trim(), role.value)
    email.value = ''
  })
}

async function changeRole(entry: ListEntry, next: SharedRole) {
  if (await run(() => props.sharing.changeRole(props.target, entry, next)))
    await load()
}

async function remove(entry: ListEntry) {
  if (await run(() => props.sharing.remove(props.target, entry)))
    await load()
}

async function leave(userId: string) {
  // Leaving takes the page away, since the person no longer has access, so the dialog goes home itself.
  if (await run(() => props.sharing.remove(props.target, { userId }))) {
    open.value = false
    await router.push({ name: 'home' })
  }
}

const ROLE_LABELS: Record<SharedRole, string> = { editor: 'Editor', viewer: 'Viewer' }
</script>

<template>
  <DialogRoot v-model:open="open">
    <DialogPortal>
      <DialogOverlay class="fixed inset-0 bg-black/60" />
      <DialogContent class="dey-panel fixed left-1/2 top-1/2 max-h-[90dvh] w-[min(92vw,32rem)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto" data-testid="share-dialog">
        <DialogTitle class="m-0 text-lg font-semibold">
          Share {{ name }}
        </DialogTitle>
        <DialogDescription class="mt-1 text-sm text-dey-muted">
          Editors can change the {{ noun }}{{ target.type === 'project' ? ' and add decks' : '' }}. Viewers can open it. Only the owner can delete it.
        </DialogDescription>

        <p v-if="loadError" class="m-0 mt-4 text-sm text-rose-300" role="alert">
          {{ loadError }}
        </p>

        <template v-else-if="list">
          <form v-if="canShare" class="mt-4 flex flex-wrap items-end gap-2" data-testid="share-form" @submit.prevent="share">
            <label class="flex min-w-48 flex-1 flex-col gap-1 text-sm">
              Email
              <input v-model="email" class="dey-input" type="email" autocomplete="off" required placeholder="name@example.com" data-testid="share-email">
            </label>
            <label class="flex flex-col gap-1 text-sm">
              Role
              <select v-model="role" class="dey-input" data-testid="share-role">
                <option value="viewer">Viewer</option>
                <option value="editor">Editor</option>
              </select>
            </label>
            <button class="dey-btn-primary" type="submit" :disabled="busy" data-testid="share-submit">
              Share
            </button>
          </form>
          <p v-else class="m-0 mt-4 text-sm text-dey-muted">
            Only the owner and editors can share.
          </p>

          <p v-if="error" class="m-0 mt-3 text-sm text-rose-300" role="alert" data-testid="share-error">
            {{ error }}
          </p>

          <ul class="m-0 mt-4 flex list-none flex-col gap-2 p-0 text-sm" data-testid="share-list">
            <li class="flex flex-wrap items-center gap-2" data-testid="share-owner">
              <span class="flex-1">{{ list.owner.name }} <span class="text-dey-muted">{{ list.owner.email }}</span></span>
              <span class="text-dey-muted">Owner</span>
            </li>
            <li v-for="member in list.members" :key="member.userId" class="flex flex-wrap items-center gap-2" :data-member="member.email">
              <span class="flex-1">{{ member.name }} <span class="text-dey-muted">{{ member.email }}</span></span>
              <select
                v-if="isOwner"
                class="dey-input w-auto py-1"
                :value="member.role"
                :aria-label="`Role of ${member.email}`"
                :disabled="busy"
                @change="changeRole({ userId: member.userId }, ($event.target as HTMLSelectElement).value as SharedRole)"
              >
                <option value="viewer">Viewer</option>
                <option value="editor">Editor</option>
              </select>
              <span v-else class="text-dey-muted">{{ ROLE_LABELS[member.role] }}</span>
              <button v-if="isOwner" class="dey-btn text-xs" :disabled="busy" data-testid="remove-member" @click="remove({ userId: member.userId })">
                Remove
              </button>
              <button v-else-if="member.email === account?.email" class="dey-btn text-xs" :disabled="busy" data-testid="leave" @click="leave(member.userId)">
                Leave
              </button>
            </li>
            <li v-for="invite in list.invites" :key="invite.id" class="flex flex-wrap items-center gap-2" :data-invite="invite.email">
              <span class="flex-1">{{ invite.email }} <span class="text-dey-muted">invited</span></span>
              <select
                v-if="isOwner"
                class="dey-input w-auto py-1"
                :value="invite.role"
                :aria-label="`Role of ${invite.email}`"
                :disabled="busy"
                @change="changeRole({ inviteId: invite.id }, ($event.target as HTMLSelectElement).value as SharedRole)"
              >
                <option value="viewer">Viewer</option>
                <option value="editor">Editor</option>
              </select>
              <span v-else class="text-dey-muted">{{ ROLE_LABELS[invite.role] }}</span>
              <button v-if="isOwner" class="dey-btn text-xs" :disabled="busy" data-testid="remove-invite" @click="remove({ inviteId: invite.id })">
                Remove
              </button>
            </li>
          </ul>
          <p v-if="target.type === 'deck'" class="m-0 mt-3 text-xs text-dey-muted">
            People the project is shared with can open this deck too.
          </p>
        </template>

        <div class="mt-4 flex justify-end">
          <DialogClose class="dey-btn">
            Done
          </DialogClose>
        </div>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
