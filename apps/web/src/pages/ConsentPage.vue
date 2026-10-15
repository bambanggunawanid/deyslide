<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { browser, redirectHost, signedQuery } from '../account/oauth'
import { runForm } from '../account/run'
import AuthCard from '../components/AuthCard.vue'
import FormError from '../components/FormError.vue'
import { useAccount } from '../composables/useAccount'

/**
 * Where an app such as Claude Code asks to use the person's account. Better
 * Auth sends people here with a signed request; the answer sends them back.
 */
const { service, account } = useAccount()
const route = useRoute()

const ANDROID_APP_REDIRECT = 'id.bambanggunawan.deyslide:/oauth/callback'

const MCP_PERMISSIONS = [
  'See your projects and decks, and those shared with you',
  'Create projects and decks',
  'Change the slides in decks you can edit',
]
const API_PERMISSIONS = ['Full access to your Deyslide account, including deleting projects and decks and sharing them']

/** The API resource is the server's address plus /api. The server signs the request, so it names only its own resources. */
function isApiResource(resource: unknown) {
  try {
    return typeof resource === 'string' && new URL(resource).pathname.endsWith('/api')
  }
  catch {
    return false
  }
}

const clientId = computed(() => typeof route.query.client_id === 'string' ? route.query.client_id : '')
const valid = computed(() => Boolean(clientId.value) && typeof route.query.sig === 'string')
const host = computed(() => redirectHost(route.query))
/** The Android app gets the answer through its own scheme, which has no host to show. */
const toAndroidApp = computed(() => route.query.redirect_uri === ANDROID_APP_REDIRECT)
/**
 * The Deyslide apps ask for the API, which reaches the whole account. MCP
 * clients such as Claude Code want the MCP endpoint. When an app linked to the
 * API leaves the resource out, the server fills it in before signing.
 */
const wholeAccount = computed(() => [route.query.resource].flat().some(isApiResource))
const permissions = computed(() => wholeAccount.value ? API_PERMISSIONS : MCP_PERMISSIONS)
const appName = ref<string>()
const busy = ref(false)
const error = ref('')
const answered = ref<'allowed' | 'denied'>()

onMounted(async () => {
  if (valid.value && account.value)
    appName.value = await service.oauthClientName(clientId.value)
})

async function answer(accept: boolean) {
  await runForm(busy, error, async () => {
    const next = await service.answerConsent(signedQuery(route.query), accept)
    answered.value = accept ? 'allowed' : 'denied'
    browser.leave(next)
  })
}
</script>

<template>
  <AuthCard title="Connect an app">
    <p v-if="!valid" class="m-0" data-testid="consent-invalid">
      This page opens when an app asks to use your Deyslide account. Start again from the app.
    </p>

    <p v-else-if="!account" class="m-0" data-testid="consent-signed-out">
      You are signed out. Sign in, then start again from the app.
    </p>

    <p v-else-if="answered" class="m-0" role="status" data-testid="consent-done">
      {{ answered === 'allowed' ? 'Allowed. You can go back to the app now.' : 'Denied. The app cannot use your account.' }}
    </p>

    <template v-else>
      <p class="m-0" data-testid="consent-app">
        <strong>{{ appName ?? 'An app' }}</strong> wants to use your Deyslide account, {{ account.email }}.
      </p>
      <div class="flex flex-col gap-1 text-sm">
        <span class="text-dey-muted">It will be able to:</span>
        <ul class="m-0 pl-5" data-testid="consent-permissions">
          <li v-for="permission in permissions" :key="permission">
            {{ permission }}
          </li>
        </ul>
        <span v-if="!wholeAccount" class="text-dey-muted" data-testid="consent-limits">It cannot delete projects or decks, and it reaches only what you can open in Deyslide.</span>
      </div>
      <p v-if="toAndroidApp" class="m-0 text-xs text-dey-muted" data-testid="consent-host">
        The app named itself. Allow it only if you just started signing in: the answer goes to the Deyslide app on this device.
      </p>
      <p v-else-if="host" class="m-0 text-xs text-dey-muted" data-testid="consent-host">
        The app named itself. Allow it only if you just started connecting from an app on this computer: it will get the answer at {{ host }}.
      </p>
      <FormError :message="error" />
      <div class="flex gap-2">
        <button class="dey-btn-primary flex-1" :disabled="busy" data-testid="consent-allow" @click="answer(true)">
          Allow
        </button>
        <button class="dey-btn flex-1" :disabled="busy" data-testid="consent-deny" @click="answer(false)">
          Deny
        </button>
      </div>
    </template>
  </AuthCard>
</template>
