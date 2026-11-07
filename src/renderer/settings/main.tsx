import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource-variable/inter'
import '@fontsource-variable/cascadia-code'
import '../styles/tokens.css'
import '../styles/app.css'
import '../styles/settings.css'
import { SettingsApp } from './SettingsApp'

const container = document.getElementById('root')
if (!container) throw new Error('Root container missing')

createRoot(container).render(
  <StrictMode>
    <SettingsApp />
  </StrictMode>
)
