<script setup lang="ts">
// Rendered by TresCanvas in its own Vue app, where Slidev context is not
// provided. This marker tells Slidev to skip injecting it.
/* @slidev-injection */
import type { Group } from 'three'
import { useLoop } from '@tresjs/core'
import { Quaternion, Vector3 } from 'three'
import { computed, shallowRef } from 'vue'
import { ARCHITECTURE_LINKS, ARCHITECTURE_NODES, linkEndpoints, nodeCenter } from './architecture'

/** Placeholder system architecture: services as blocks, calls as rods. */
const props = withDefaults(defineProps<{
  focus?: string
  /** Radians per second around the Y axis. 0 keeps the scene still. */
  spin?: number
}>(), { spin: 0 })

const group = shallowRef<Group>()
const UP = new Vector3(0, 1, 0)

const links = computed(() => ARCHITECTURE_LINKS.flatMap((link) => {
  const ends = linkEndpoints(link)
  if (!ends)
    return []
  const [from, to] = ends.map(point => new Vector3(...point))
  const direction = to.clone().sub(from)
  const length = direction.length()
  return [{
    key: `${link.from}-${link.to}`,
    position: from.clone().add(to).multiplyScalar(0.5).toArray(),
    quaternion: new Quaternion().setFromUnitVectors(UP, direction.normalize()),
    length,
  }]
}))

const { onBeforeRender } = useLoop()
onBeforeRender(({ delta }) => {
  if (group.value && props.spin)
    group.value.rotation.y += props.spin * delta
})
</script>

<template>
  <TresGroup ref="group">
    <TresMesh
      v-for="node in ARCHITECTURE_NODES"
      :key="node.id"
      :name="node.id"
      :position="nodeCenter(node)"
    >
      <TresBoxGeometry :args="node.size" />
      <TresMeshStandardMaterial
        :color="node.color"
        :emissive="node.color"
        :emissive-intensity="node.id === focus ? 0.9 : 0.08"
        :transparent="true"
        :opacity="!focus || node.id === focus ? 1 : 0.35"
        :metalness="0.2"
        :roughness="0.35"
      />
    </TresMesh>
    <TresMesh
      v-for="link in links"
      :key="link.key"
      :position="link.position"
      :quaternion="link.quaternion"
    >
      <TresCylinderGeometry :args="[0.04, 0.04, link.length, 8]" />
      <TresMeshStandardMaterial color="#64748b" :emissive="'#64748b'" :emissive-intensity="0.3" />
    </TresMesh>
    <TresGridHelper :args="[24, 24, '#1e293b', '#111827']" :position="[0, -0.01, 0]" />
  </TresGroup>
</template>
