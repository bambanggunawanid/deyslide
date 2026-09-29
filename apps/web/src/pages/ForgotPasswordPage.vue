<script setup lang="ts">
import { ref } from 'vue'
import { runForm } from '../account/run'
import AuthCard from '../components/AuthCard.vue'
import FormError from '../components/FormError.vue'
import { useAccount } from '../composables/useAccount'

const { service } = useAccount()

const email = ref('')
const busy = ref(false)
const error = ref('')
const sent = ref(false)

async function request() {
  sent.value = await runForm(busy, error, () => service.requestPasswordReset(email.value))
}
</script>

<template>
  <AuthCard title="Reset your password">
    <p v-if="sent" class="m-0" data-testid="reset-sent">
      If {{ email }} has a Deyslide account, we sent it a link to choose a new password. The link expires in 1 hour.
    </p>
    <form v-else class="flex flex-col gap-3" @submit.prevent="request">
      <label class="flex flex-col gap-1 text-sm">
        Email
        <input v-model="email" class="dey-input" type="email" autocomplete="email" required data-testid="email">
      </label>
      <FormError :message="error" />
      <button class="dey-btn-primary" type="submit" :disabled="busy" data-testid="submit">
        Send reset link
      </button>
    </form>
    <RouterLink to="/sign-in" class="text-sm text-dey-accent">
      Back to sign in
    </RouterLink>
  </AuthCard>
</template>
