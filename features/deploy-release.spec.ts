// @vitest-environment node
import { readFileSync } from 'node:fs'
import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber'
import { expect } from 'vitest'

const feature = await loadFeature('./deploy-release.feature')

/** The release's top level folders, from `mkdir -p release/site/demo release/server ...`. */
function packedFolders(workflow: string) {
  const mkdir = workflow.match(/mkdir -p (release\/\S+(?: release\/\S+)*)/)![1]
  return [...new Set(mkdir.split(' ').map(path => path.split('/')[1]))]
}

describeFeature(feature, ({ Scenario }) => {
  let workflow: string
  let packed: string[]

  Scenario('Every packed folder is moved into place', ({ Given, Then, And }) => {
    Given('the Deploy workflow', () => {
      workflow = readFileSync(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8')
    })
    Then('the release packs the folders "site", "server" and "renderer"', () => {
      packed = packedFolders(workflow)
      expect(packed).toEqual(['site', 'server', 'renderer'])
    })
    And('starting the containers moves each of those folders into place', () => {
      const moved = workflow.match(/for folder in ([\w ]+); do/)![1].split(' ')
      expect(moved).toEqual(packed)
    })
    And('the folders they replace are removed after the containers start', () => {
      expect(workflow).toContain(`rm -rf ${packed.map(folder => `${folder}.old`).join(' ')}`)
    })
  })
})
