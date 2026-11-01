const KEY = 'snowcast.favorites'
const SECTIONS_KEY = 'snowcast.sections'
const DEFAULT_FAVORITES = ['wolf-creek', 'breckenridge', 'vail', 'steamboat', 'denver']

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) : fallback
  } catch {
    return fallback
  }
}

function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Private mode or blocked storage: the setting just won't persist.
  }
}

export const loadFavorites = (): string[] => read(KEY, DEFAULT_FAVORITES)
export const saveFavorites = (ids: string[]) => write(KEY, ids)

/** Open/closed state of the collapsible location sections, by section key. */
export const loadOpenSections = (): Record<string, boolean> => read(SECTIONS_KEY, {})
export const saveOpenSections = (state: Record<string, boolean>) => write(SECTIONS_KEY, state)

/** Move the item at `from` to `to`, returning a new array. */
export function moveItem<T>(items: T[], from: number, to: number): T[] {
  if (to < 0 || to >= items.length || from === to) return items
  const next = items.slice()
  const [item] = next.splice(from, 1)
  next.splice(to, 0, item)
  return next
}
