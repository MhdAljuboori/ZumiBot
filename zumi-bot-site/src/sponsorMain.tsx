import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// Bundled like the home page's: the CSP (vercel.json) allows fonts from this site only.
import '@fontsource-variable/bricolage-grotesque/opsz.css'
import { SponsorPage } from './SponsorPage.tsx'
import './styles.css'

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <SponsorPage />
  </StrictMode>
)
