import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource-variable/inter'
import '../styles/tokens.css'
import '../styles/overlay.css'
import { OverlayApp } from './OverlayApp'

const container = document.getElementById('root')
if (!container) throw new Error('Root container missing')

createRoot(container).render(
  <StrictMode>
    <OverlayApp />
  </StrictMode>
)
