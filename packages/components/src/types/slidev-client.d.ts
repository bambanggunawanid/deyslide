/**
 * Type surface of `@slidev/client` that Deyslide uses.
 * Slidev resolves the real module at runtime. It ships raw TypeScript that
 * only compiles inside Slidev's own build, so the typecheck reads this file.
 */
declare module '@slidev/client' {
  import type { ComputedRef, Ref } from 'vue'

  export function useIsSlideActive(): ComputedRef<boolean>

  export function useSlideContext(): {
    $renderContext: Ref<string>
  }

  export function useNav(): {
    isPrintMode: ComputedRef<boolean>
  }
}
