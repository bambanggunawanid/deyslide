<script setup lang="ts">
import { DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuPortal, DropdownMenuRoot, DropdownMenuSeparator, DropdownMenuTrigger } from 'reka-ui'
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { useAccount } from '../composables/useAccount'

const { service, account, setAccount } = useAccount()
const router = useRouter()
const error = ref('')

async function signOut() {
  error.value = ''
  try {
    await service.signOut()
    await setAccount(undefined)
    await router.push('/')
  }
  catch {
    error.value = 'Signing out did not work. Try again.'
  }
}
</script>

<template>
  <DropdownMenuRoot v-if="account">
    <DropdownMenuTrigger class="dey-btn max-w-48 truncate text-sm" data-testid="account-menu">
      {{ account.name || account.email }}
    </DropdownMenuTrigger>
    <DropdownMenuPortal>
      <DropdownMenuContent align="end" :side-offset="6" class="dey-panel z-10 flex min-w-56 flex-col gap-1 p-2">
        <DropdownMenuLabel class="px-2 py-1 text-sm">
          <span class="block font-medium">{{ account.name }}</span>
          <span class="block text-dey-muted" data-testid="account-email">{{ account.email }}</span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator class="my-1 h-px bg-dey-line" />
        <DropdownMenuItem class="cursor-pointer rounded px-2 py-1 text-sm outline-none data-[highlighted]:bg-dey-line" data-testid="sign-out" @select="signOut">
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenuPortal>
  </DropdownMenuRoot>
  <span v-if="error" class="text-sm text-rose-300" role="alert">{{ error }}</span>
</template>
