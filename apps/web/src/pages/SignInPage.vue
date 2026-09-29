<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { browser, oauthContinueUrl } from '../account/oauth'
import { runForm } from '../account/run'
import AuthCard from '../components/AuthCard.vue'
import FormError from '../components/FormError.vue'
import SocialButtons from '../components/SocialButtons.vue'
import { useAccount } from '../composables/useAccount'

const { service, options, setAccount } = useAccount()
const route = useRoute()
const router = useRouter()

const mode = ref<'password' | 'link' | 'link-sent'>('password')
const email = ref('')
const password = ref('')
const busy = ref(false)
const error = ref('')

const LINK_ERRORS: Record<string, string> = {
  link: 'That sign in link expired or was already used. Ask for a new one.',
  social: 'Signing in with that account did not work. Try again or use another option.',
}
const linkError = computed(() => LINK_ERRORS[String(route.query.error)] ?? '')
const anyOption = computed(() => options.email || options.google || options.github)

// An app such as Claude Code sent the person here. After signing in, its request carries on.
const next = computed(() => oauthContinueUrl(route.query))
const { account } = useAccount()

onMounted(async () => {
  if (next.value && account.value)
    browser.leave(next.value)
})

async function signIn() {
  await runForm(busy, error, async () => {
    await setAccount(await service.signIn({ email: email.value, password: password.value, next: next.value }))
    if (next.value)
      browser.leave(next.value)
    else
      await router.push('/')
  })
}

async function sendLink() {
  if (await runForm(busy, error, () => service.sendMagicLink(email.value, next.value)))
    mode.value = 'link-sent'
}
</script>

<template>
  <AuthCard title="Sign in">
    <p class="m-0 text-sm text-dey-muted">
      New to Deyslide?
      <RouterLink to="/sign-up" class="text-dey-accent">
        Create an account
      </RouterLink>
    </p>

    <p v-if="next" class="m-0 rounded-md border border-dey-line p-3 text-sm" data-testid="oauth-sign-in">
      An app wants to connect to your Deyslide account. Sign in, then choose whether to allow it.
    </p>

    <FormError :message="linkError" />

    <p v-if="!anyOption" class="m-0" data-testid="sign-in-unavailable">
      Sign in is unavailable right now. Your projects stay safe in this browser.
    </p>

    <SocialButtons :next="next" />

    <template v-if="options.email">
      <p v-if="options.google || options.github" class="m-0 text-center text-sm text-dey-muted">
        or
      </p>

      <div v-if="mode === 'link-sent'" class="flex flex-col gap-3" data-testid="link-sent">
        <p class="m-0">
          Check {{ email }}. We sent a sign in link that works once and expires in 10 minutes.
        </p>
        <button class="dey-btn self-start text-sm" @click="mode = 'link'">
          Use another email
        </button>
      </div>

      <form v-else-if="mode === 'link'" class="flex flex-col gap-3" data-testid="magic-link-form" @submit.prevent="sendLink">
        <label class="flex flex-col gap-1 text-sm">
          Email
          <input v-model="email" class="dey-input" type="email" autocomplete="email" required data-testid="email">
        </label>
        <FormError :message="error" />
        <button class="dey-btn-primary" type="submit" :disabled="busy" data-testid="submit">
          Email me a sign in link
        </button>
        <button class="dey-btn text-sm" type="button" @click="mode = 'password'">
          Use a password instead
        </button>
      </form>

      <form v-else class="flex flex-col gap-3" data-testid="password-form" @submit.prevent="signIn">
        <label class="flex flex-col gap-1 text-sm">
          Email
          <input v-model="email" class="dey-input" type="email" autocomplete="email" required data-testid="email">
        </label>
        <label class="flex flex-col gap-1 text-sm">
          Password
          <input v-model="password" class="dey-input" type="password" autocomplete="current-password" required data-testid="password">
        </label>
        <RouterLink to="/forgot-password" class="self-end text-sm text-dey-accent">
          Forgot password?
        </RouterLink>
        <FormError :message="error" />
        <button class="dey-btn-primary" type="submit" :disabled="busy" data-testid="submit">
          Sign in
        </button>
        <button class="dey-btn text-sm" type="button" data-testid="use-magic-link" @click="mode = 'link'">
          Email me a sign in link instead
        </button>
      </form>
    </template>
  </AuthCard>
</template>
