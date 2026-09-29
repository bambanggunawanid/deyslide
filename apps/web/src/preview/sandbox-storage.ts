/**
 * The preview frame is sandboxed without same origin access, so reading
 * `localStorage` or `sessionStorage` throws. Libraries such as TresJS read
 * them anyway. Give the frame in-memory versions: nothing a slide stores
 * persists or reaches the app. Import this module before any other.
 */
function memoryStorage(): Storage {
  const items = new Map<string, string>()
  return {
    get length() {
      return items.size
    },
    clear: () => items.clear(),
    getItem: key => items.get(key) ?? null,
    key: index => [...items.keys()][index] ?? null,
    removeItem: (key) => {
      items.delete(key)
    },
    setItem: (key, value) => {
      items.set(key, String(value))
    },
  }
}

for (const name of ['localStorage', 'sessionStorage'] as const) {
  try {
    void window[name]
  }
  catch {
    Object.defineProperty(window, name, { value: memoryStorage(), configurable: true })
  }
}
