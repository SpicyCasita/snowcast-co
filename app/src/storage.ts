const KEY = 'snowcast.favorites'
const DEFAULT_FAVORITES = ['wolf-creek', 'breckenridge', 'vail', 'steamboat', 'denver']

export function loadFavorites(): string[] {
  try {
    const raw = localStorage.getItem(KEY)
    return raw ? JSON.parse(raw) : DEFAULT_FAVORITES
  } catch {
    return DEFAULT_FAVORITES
  }
}

export function saveFavorites(ids: string[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(ids))
  } catch {
    // Private mode or blocked storage: favorites just won't persist.
  }
}
