/** Where every version of the apps is listed. */
export const RELEASES_PAGE = 'https://github.com/bambanggunawanid/deyslide/releases'

/** GitHub's description of the newest published release, with its files. */
export const LATEST_RELEASE_API = 'https://api.github.com/repos/bambanggunawanid/deyslide/releases/latest'

/** The app files a release carries, one kind per installer. */
export type AppFile = 'windows-setup' | 'windows-msi' | 'macos' | 'linux-appimage' | 'linux-deb' | 'android'

/** How each kind is named by the release workflow, such as `Deyslide_0.2.0_x64-setup.exe`. */
const FILE_NAMES: Record<AppFile, RegExp> = {
  'windows-setup': /-setup\.exe$/i,
  'windows-msi': /\.msi$/i,
  'macos': /\.dmg$/i,
  'linux-appimage': /\.appimage$/i,
  'linux-deb': /\.deb$/i,
  'android': /\.apk$/i,
}

export interface LatestRelease {
  /** The release's tag, such as `v0.2.0`. */
  version?: string
  /** Download links of the files found. A kind that is missing has none. */
  files: Partial<Record<AppFile, string>>
}

interface ReleaseResponse {
  tag_name?: string
  assets?: { name: string, browser_download_url: string }[]
}

/**
 * The newest release's app files, matched by name. Nothing is found when
 * GitHub cannot be reached or there is no release yet; the download page
 * then links to {@link RELEASES_PAGE}.
 */
export async function latestRelease(fetchImpl: typeof fetch = fetch): Promise<LatestRelease> {
  let release: ReleaseResponse
  try {
    const response = await fetchImpl(LATEST_RELEASE_API, { headers: { accept: 'application/vnd.github+json' } })
    if (!response.ok)
      return { files: {} }
    release = await response.json() as ReleaseResponse
  }
  catch {
    return { files: {} }
  }
  // An APK without a signature cannot be installed.
  const assets = (release.assets ?? []).filter(asset => !/unsigned/i.test(asset.name))
  const files: LatestRelease['files'] = {}
  for (const [kind, pattern] of Object.entries(FILE_NAMES) as [AppFile, RegExp][]) {
    const asset = assets.find(asset => pattern.test(asset.name))
    if (asset)
      files[kind] = asset.browser_download_url
  }
  return { version: release.tag_name, files }
}
