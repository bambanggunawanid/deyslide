interface ImportMetaEnv {
  /** `1` in the pages the Deyslide app bundles (`vite build --mode app`, from `.env.app`). */
  readonly VITE_APP?: string
  /** The server the app talks to when it cannot say which one its settings name. */
  readonly VITE_SERVER_URL?: string
}
