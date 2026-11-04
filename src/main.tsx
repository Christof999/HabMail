import { LanguageBoundary } from './LanguageSettings'
import { watchLanguage } from './languageSession'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { ThemeProvider } from './ThemeProvider'

try { watchLanguage() } catch (error) { console.error(error) }

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider>
      <LanguageBoundary><App /></LanguageBoundary>
    </ThemeProvider>
  </StrictMode>,
)
