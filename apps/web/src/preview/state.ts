import { ref, shallowRef } from 'vue'

/** How many clicks into the slide the preview is, like Slidev's `$clicks`. */
export const clicks = ref(0)
/** Whether the page shows the dark color schema. */
export const dark = shallowRef(false)
