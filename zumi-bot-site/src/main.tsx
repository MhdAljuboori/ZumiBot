import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// The display face is bundled, not linked from a font host: the CSP (vercel.json) allows fonts from this site only.
import '@fontsource-variable/bricolage-grotesque/opsz.css'
import { App } from './App.tsx'
import './styles.css'

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>
)
