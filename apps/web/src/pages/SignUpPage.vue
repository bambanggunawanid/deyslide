<script setup lang="ts">
import { ref } from 'vue'
import { runForm } from '../account/run'
import AuthCard from '../components/AuthCard.vue'
import FormError from '../components/FormError.vue'
import SocialButtons from '../components/SocialButtons.vue'
import { useAccount } from '../composables/useAccount'

const { service, options } = useAccount()

const name = ref('')
const email = ref('')
const password = ref('')
const busy = ref(false)
const error = ref('')
const sent = ref(false)

async function signUp() {
  sent.value = await runForm(busy, error, () => service.signUp({ name: name.value.trim(), email: email.value, password: password.value }))
}
</script>

<template>
  <AuthCard title="Create your account">
    <p class="m-0 text-sm text-dey-muted">
      Already have one?
      <RouterLink to="/sign-in" class="text-dey-accent">
        Sign in
      </RouterLink>
    </p>

    <div v-if="sent" class="flex flex-col gap-2" data-testid="confirm-sent">
      <p class="m-0">
        Check {{ email }}. Open the link we sent to confirm your address, and you will be signed in.
      </p>
    </div>

    <template v-else>
      <SocialButtons />

      <p v-if="options.email && (options.google || options.github)" class="m-0 text-center text-sm text-dey-muted">
        or
      </p>

      <form v-if="options.email" class="flex flex-col gap-3" data-testid="sign-up-form" @submit.prevent="signUp">
        <label class="flex flex-col gap-1 text-sm">
          Name
          <input v-model="name" class="dey-input" autocomplete="name" required maxlength="80" data-testid="name">
        </label>
        <label class="flex flex-col gap-1 text-sm">
          Email
          <input v-model="email" class="dey-input" type="email" autocomplete="email" required data-testid="email">
        </label>
        <label class="flex flex-col gap-1 text-sm">
          Password
          <input v-model="password" class="dey-input" type="password" autocomplete="new-password" required minlength="8" data-testid="password">
          <span class="text-dey-muted">At least 8 characters.</span>
        </label>
        <FormError :message="error" />
        <button class="dey-btn-primary" type="submit" :disabled="busy" data-testid="submit">
          Create account
        </button>
      </form>

      <p v-if="!options.email && !options.google && !options.github" class="m-0" data-testid="sign-up-unavailable">
        Sign up is unavailable right now. Your projects stay safe in this browser.
      </p>
    </template>
  </AuthCard>
</template>
