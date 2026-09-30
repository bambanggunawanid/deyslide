// @vitest-environment node
import { readFileSync } from 'node:fs'
import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber'
import { expect } from 'vitest'

const feature = await loadFeature('./deploy-settings.feature')

describeFeature(feature, ({ Scenario }) => {
  let workflow: string

  Scenario('The Cloudflare account ID can be a variable or a secret', ({ Given, Then, And }) => {
    Given('the Deploy workflow', () => {
      workflow = readFileSync(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8')
    })
    Then('it reads "CLOUDFLARE_ACCOUNT_ID" from the environment\'s variables, then its secrets', () => {
      expect(workflow).toContain('CLOUDFLARE_ACCOUNT_ID: ${{ vars.CLOUDFLARE_ACCOUNT_ID || secrets.CLOUDFLARE_ACCOUNT_ID }}')
    })
    And('it writes "CLOUDFLARE_ACCOUNT_ID" into the server\'s settings', () => {
      expect(workflow).toMatch(/for name in CLOUDFLARE_ACCOUNT_ID /)
    })
  })
})
