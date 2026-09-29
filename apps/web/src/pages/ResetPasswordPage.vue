<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRoute } from 'vue-router'
import { runForm } from '../account/run'
import AuthCard from '../components/AuthCard.vue'
import FormError from '../components/FormError.vue'
import { useAccount } from '../composables/useAccount'

const { service } = useAccount()
const route = useRoute()

const token = computed(() => typeof route.query.token === 'string' ? route.query.token : '')
const password = ref('')
const busy = ref(false)
const error = ref('')
const done = ref(false)

async function reset() {
  done.value = await runForm(busy, error, () => service.resetPassword({ token: token.value, password: password.value }))
}
</script>

<template>
  <AuthCard title="Choose a new password">
    <p v-if="!token" class="m-0" role="alert" data-testid="reset-invalid">
      This link expired or was already used.
      <RouterLink to="/forgot-password" class="text-dey-accent">
        Ask for a new one
      </RouterLink>.
    </p>
    <p v-else-if="done" class="m-0" data-testid="reset-done">
      Your password is changed.
      <RouterLink to="/sign-in" class="text-dey-accent">
        Sign in
      </RouterLink>
      with it now.
    </p>
    <form v-else class="flex flex-col gap-3" @submit.prevent="reset">
      <label class="flex flex-col gap-1 text-sm">
        New password
        <input v-model="password" class="dey-input" type="password" autocomplete="new-password" required minlength="8" data-testid="password">
        <span class="text-dey-muted">At least 8 characters.</span>
      </label>
      <FormError :message="error" />
      <button class="dey-btn-primary" type="submit" :disabled="busy" data-testid="submit">
        Save password
      </button>
    </form>
  </AuthCard>
</template>
