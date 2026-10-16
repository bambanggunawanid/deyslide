import type { InvokeArgs, InvokeOptions } from '@tauri-apps/api/core'
import type { Event, UnlistenFn } from '@tauri-apps/api/event'

/**
 * Typed calls into the Deyslide app's Rust side (`apps/native/src-tauri`):
 * one wrapper for each command it offers and each event it sends. Only
 * code running inside the app may call them. `@tauri-apps/api` loads on
 * the first call, so the website never downloads it.
 */

/** The library folder of decks on this device. */
export interface LibraryInfo {
  root: string
  /** False until the app creates the folder on first use. */
  exists: boolean
}

/** A deck file in a project folder. Times are milliseconds since 1970. */
export interface LocalDeckInfo {
  /** `local-d-` and 16 hex characters. Changes when the deck or its project is renamed. */
  id: string
  projectId: string
  projectName: string
  /** The file name without `.md`. */
  name: string
  /** The file's full path. */
  path: string
  slideCount: number
  createdAt: number
  updatedAt: number
}

/** A project folder with its decks. */
export interface LocalProjectInfo {
  /** `local-p-` and 16 hex characters. Changes when the project is renamed. */
  id: string
  name: string
  path: string
  createdAt: number
  updatedAt: number
  decks: LocalDeckInfo[]
}

/** A compare and swap write: written, or refused because the file holds `current`. */
export type WriteDeckResult
  = | { ok: true }
    | { conflict: true, current: string }

/** Which click step to draw: every click done, or a step number. */
export type RenderClicks = 'last' | number

export interface RenderSlideRequest {
  /** Slide number, starting at 1. */
  number: number
  clicks: RenderClicks
}

/** `render-request`: draw these slides of `markdown` and answer with {@link renderRespond}. */
export interface RenderRequestEvent {
  id: string
  markdown: string
  slides: RenderSlideRequest[]
  width: number
  height: number
}

/** One drawn slide, as the cloud renderer reports it. */
export interface RenderedSlide {
  /** PNG in base64. Missing when the slide failed to draw. */
  png?: string
  clicks: number
  overflow: boolean
  error?: string
}

/** The signed in person, from the server's `/api/me`. */
export interface AppAccount {
  id: string
  name: string
  email: string
}

/** The command that connects Claude Code to this app, or why there is none. */
export type McpSetup
  = | { command: string }
    | { problem: string }

export type AppPlatform = 'windows' | 'macos' | 'linux' | 'android'

export interface AppInfo {
  version: string
  platform: AppPlatform
  /** The Deyslide server the app signs in to. */
  serverUrl: string
}

/** `deck-changed`: a deck's file changed on disk. */
export interface DeckChangedEvent {
  deckId: string
}

/** `present-sync`: what the presenter and audience windows of a deck tell each other. */
export interface PresentSyncEvent<T = unknown> {
  deckId: string
  message: T
}

/** A `present-sync` event as it travels: with the label of the window that sent it. */
interface SentPresentSync<T> extends PresentSyncEvent<T> {
  from?: string
}

/** The header that carries {@link saveFile}'s path. */
export const SAVE_PATH_HEADER = 'x-deyslide-path'

/**
 * Loads a module on first use, once: calls made at the same time share the
 * load. (Vitest's module mocks also only hold for imports that do not
 * overlap.) A failed load is tried again on the next call.
 */
function once<T>(load: () => Promise<T>) {
  let loading: Promise<T> | undefined
  return () => loading ??= load().catch((error) => {
    loading = undefined
    throw error
  })
}

const tauriCore = once(() => import('@tauri-apps/api/core'))
const tauriEvent = once(() => import('@tauri-apps/api/event'))
const tauriWindow = once(() => import('@tauri-apps/api/webviewWindow'))

async function call<T>(command: string, args?: InvokeArgs, options?: InvokeOptions): Promise<T> {
  const { invoke } = await tauriCore()
  return invoke<T>(command, args, options)
}

async function on<T>(event: string, handler: (payload: T) => void): Promise<UnlistenFn> {
  const { listen } = await tauriEvent()
  return listen<T>(event, (received: Event<T>) => handler(received.payload))
}

async function currentWindow() {
  const { getCurrentWebviewWindow } = await tauriWindow()
  return getCurrentWebviewWindow()
}

export function libraryInfo() {
  return call<LibraryInfo>('library_info')
}

/** Makes `path` the library folder, for the app and for Claude Code. Computers only. */
export function librarySetRoot(path: string) {
  return call<LibraryInfo>('library_set_root', { path })
}

export function libraryList() {
  return call<LocalProjectInfo[]>('library_list')
}

export function libraryCreateProject(name: string) {
  return call<LocalProjectInfo>('library_create_project', { name })
}

/** Renames the project folder. The result carries the new ids of the project and its decks. */
export function libraryRenameProject(id: string, name: string) {
  return call<LocalProjectInfo>('library_rename_project', { id, name })
}

/** Moves the project folder to the trash where the system has one. Ask the person first. */
export function libraryDeleteProject(id: string) {
  return call<void>('library_delete_project', { id })
}

export function libraryCreateDeck(projectId: string, name: string, markdown: string) {
  return call<LocalDeckInfo>('library_create_deck', { projectId, name, markdown })
}

/** Renames the deck file. The result carries the deck's new id. */
export function libraryRenameDeck(id: string, name: string) {
  return call<LocalDeckInfo>('library_rename_deck', { id, name })
}

/** Moves the deck file to the trash where the system has one. */
export function libraryDeleteDeck(id: string) {
  return call<void>('library_delete_deck', { id })
}

export function libraryReadDeck(id: string) {
  return call<string>('library_read_deck', { id })
}

/** Writes the deck only when its file still holds `expected` (any content when null). */
export function libraryWriteDeck(id: string, content: string, expected: string | null) {
  return call<WriteDeckResult>('library_write_deck', { id, content, expected })
}

/** Answers a {@link RenderRequestEvent} with one result per requested slide. */
export function renderRespond(id: string, slides: RenderedSlide[]) {
  return call<void>('render_respond', { id, slides })
}

/**
 * Signs in through the browser. On a computer it resolves once signed in;
 * on Android once the browser is open. `account-changed` follows either way.
 */
export function authSignIn() {
  return call<void>('auth_sign_in')
}

export function authSignOut() {
  return call<void>('auth_sign_out')
}

/** An access token for the server's API, refreshed when it is about to expire. Fails when signed out. */
export function authAccessToken() {
  return call<string>('auth_access_token')
}

/** The signed in person, or null when signed out. */
export function authAccount() {
  return call<AppAccount | null>('auth_account')
}

export function mcpSetup() {
  return call<McpSetup>('mcp_setup')
}

/** Opens the audience window for a deck. Computers only. */
export function presentOpen(projectId: string, deckId: string) {
  return call<void>('present_open', { projectId, deckId })
}

/** Writes `bytes` to `path`, a path the person picked in a save dialog. Computers only. */
export function saveFile(path: string, bytes: Uint8Array) {
  return call<void>('save_file', bytes, { headers: { [SAVE_PATH_HEADER]: encodeURIComponent(path) } })
}

export function appInfo() {
  return call<AppInfo>('app_info')
}

/** The app's main window. Audience windows are `present-<deckId>`. */
export const MAIN_WINDOW = 'main'

/** The label of the window this page runs in. */
export async function windowLabel() {
  return (await currentWindow()).label
}

/**
 * Runs `handler` when the person closes this window. The window closes once
 * it resolves true and stays open when it resolves false. A handler that
 * fails lets the window close.
 */
export async function onCloseRequested(handler: () => Promise<boolean>): Promise<UnlistenFn> {
  return (await currentWindow()).onCloseRequested(async (event) => {
    let close = true
    try {
      close = await handler()
    }
    catch (error) {
      console.error('Deyslide could not get ready to close:', error)
    }
    if (!close)
      event.preventDefault()
  })
}

/** Projects or decks were added, removed, renamed or edited in the library folder. */
export function onLibraryChanged(handler: () => void) {
  return on<null>('library-changed', () => handler())
}

export function onDeckChanged(handler: (event: DeckChangedEvent) => void) {
  return on<DeckChangedEvent>('deck-changed', handler)
}

/**
 * Draws slides for Claude Code. Call it in the main window only: the app
 * sends requests there alone, and holds each one until this listener is
 * ready (it tells the app through `render_ready`).
 */
export async function onRenderRequest(handler: (event: RenderRequestEvent) => void): Promise<UnlistenFn> {
  const current = await currentWindow()
  const unlisten = await current.listen<RenderRequestEvent>('render-request', received => handler(received.payload))
  try {
    await call<void>('render_ready', { ready: true })
  }
  catch (error) {
    unlisten()
    throw error
  }
  return () => {
    unlisten()
    void call<void>('render_ready', { ready: false })
  }
}

/** Signed in or out, also when the server ended the sign in. */
export function onAccountChanged(handler: () => void) {
  return on<null>('account-changed', () => handler())
}

/** Hears what the deck's other windows send; never what this window sent itself. */
export async function onPresentSync<T = unknown>(handler: (event: PresentSyncEvent<T>) => void): Promise<UnlistenFn> {
  const own = (await currentWindow()).label
  return on<SentPresentSync<T>>('present-sync', ({ from, ...event }) => {
    if (from !== own)
      handler(event)
  })
}

/** Tells the app's other windows, the audience window included. */
export async function emitPresentSync<T>(event: PresentSyncEvent<T>) {
  const [{ emit }, current] = await Promise.all([tauriEvent(), currentWindow()])
  const sent: SentPresentSync<T> = { ...event, from: current.label }
  return emit('present-sync', sent)
}
