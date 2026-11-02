import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource-variable/outfit/index.css'
import './index.css'
import App from './App.tsx'
import { applyTheme, loadTheme } from './theme'

// Before the first render, so a forced theme never flashes the other one.
applyTheme(loadTheme())

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
