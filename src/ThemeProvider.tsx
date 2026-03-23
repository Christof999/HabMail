import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'

const STORAGE_KEY = 'habmail-theme'

export type ThemeMode = 'system' | 'light' | 'dark'

function readStored(): ThemeMode {
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    if (v === 'light' || v === 'dark' || v === 'system') return v
  } catch {
    /* ignore */
  }
  return 'system'
}

function isDarkResolved(theme: ThemeMode): boolean {
  if (theme === 'dark') return true
  if (theme === 'light') return false
  return globalThis.window.matchMedia('(prefers-color-scheme: dark)').matches
}

function applyMetaThemeColor(dark: boolean) {
  const el = document.getElementById('habmail-theme-color')
  if (el && 'content' in el) {
    ;(el as HTMLMetaElement).content = dark ? '#1c1c1e' : '#f2f2f7'
  }
}

const ThemeCtx = createContext<{
  theme: ThemeMode
  setTheme: (t: ThemeMode) => void
} | null>(null)

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<ThemeMode>(readStored)

  const setTheme = useCallback((t: ThemeMode) => {
    setThemeState(t)
    try {
      localStorage.setItem(STORAGE_KEY, t)
    } catch {
      /* ignore */
    }
  }, [])

  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme
    applyMetaThemeColor(isDarkResolved(theme))
  }, [theme])

  useEffect(() => {
    if (theme !== 'system') return
    const mq = globalThis.window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => applyMetaThemeColor(mq.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [theme])

  const value = useMemo(() => ({ theme, setTheme }), [theme, setTheme])

  return <ThemeCtx.Provider value={value}>{children}</ThemeCtx.Provider>
}

export function useTheme(): {
  theme: ThemeMode
  setTheme: (t: ThemeMode) => void
} {
  const c = useContext(ThemeCtx)
  if (!c) throw new Error('useTheme außerhalb von ThemeProvider')
  return c
}

export function ThemeAppearanceControl() {
  const { theme, setTheme } = useTheme()
  return (
    <div
      className="segmented theme-segmented"
      role="group"
      aria-label="Erscheinungsbild"
    >
      <button
        type="button"
        className={theme === 'system' ? 'active' : ''}
        onClick={() => setTheme('system')}
      >
        Auto
      </button>
      <button
        type="button"
        className={theme === 'light' ? 'active' : ''}
        onClick={() => setTheme('light')}
      >
        Hell
      </button>
      <button
        type="button"
        className={theme === 'dark' ? 'active' : ''}
        onClick={() => setTheme('dark')}
      >
        Dunkel
      </button>
    </div>
  )
}
