import { createContext, useContext } from 'react'

export type ThemeMode = 'system' | 'light' | 'dark'

export const ThemeCtx = createContext<{
  theme: ThemeMode
  setTheme: (t: ThemeMode) => void
} | null>(null)

export function useTheme(): {
  theme: ThemeMode
  setTheme: (t: ThemeMode) => void
} {
  const c = useContext(ThemeCtx)
  if (!c) throw new Error('useTheme außerhalb von ThemeProvider')
  return c
}
