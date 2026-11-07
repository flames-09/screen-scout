import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource-variable/inter'
import '@fontsource-variable/cascadia-code'
import '../styles/tokens.css'
import '../styles/app.css'
import '../styles/assistant.css'
import { AssistantApp } from './App'

const container = document.getElementById('root')
if (!container) throw new Error('Root container missing')

createRoot(container).render(
  <StrictMode>
    <AssistantApp />
  </StrictMode>
)
