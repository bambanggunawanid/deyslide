import { computed } from 'vue'
import { mode } from './state'

/** True while the slide is drawn for an export, like Slidev's print mode. */
export const isPrintMode = computed(() => mode.value === 'print')
