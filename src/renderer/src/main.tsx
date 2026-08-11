// Inter is declared as an @font-face in base.css against the variable font file
// bundled from hue-mobile, so there is no font package to import here.
import './assets/main.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { requestPersistentStorage } from './lib/persistentStorage'

// Make the on-device model cache durable before anything starts loading models,
// so Chromium never evicts ~190 MB of ONNX weights and forces a re-download.
void requestPersistentStorage()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
