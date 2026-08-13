// Inter is declared as an @font-face in base.css against the variable font file
// bundled from hue-mobile, so there is no font package to import here.
import './assets/main.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { ErrorBoundary } from './components/ErrorBoundary'
import { requestPersistentStorage } from './lib/persistentStorage'

// Make the on-device model cache durable before anything starts loading models,
// so Chromium never evicts ~190 MB of ONNX weights and forces a re-download.
void requestPersistentStorage()

// An unhandled rejection in the renderer does not kill the window, but it does
// mean a failure went unreported — during a session that reads as Hue quietly
// doing nothing. Log it where the crash would be read from.
window.addEventListener('unhandledrejection', (e) => {
  console.error('unhandled rejection in renderer:', e.reason)
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>
)
