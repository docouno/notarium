import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { PwaProvider } from './composers/PwaProvider'
import { DialogProvider } from './core/Dialog'
import { ErrorBoundary } from './core/ErrorBoundary'
import { ToastProvider } from './core/Toast'
// Global stylesheet layer: theme tokens, reset/shell, rendered-markdown body, and
// the small set of deliberately-shared utility classes. Everything else is a
// co-located *.module.scss next to its component.
import './styles/tokens.scss'
import './styles/reading-faces.scss'
import './styles/reading.scss'
import './styles/base.scss'
// KaTeX base stylesheet (#237) — its `.katex*` rules and @font-face declarations (the
// KaTeX web fonts get bundled as assets by Vite). Imported BEFORE markdown.scss so our
// theme overrides there (error colour → --danger, display-math scroll) win the cascade.
import 'katex/dist/katex.min.css'
import './styles/markdown.scss'
import './styles/code-themes.scss'
import './styles/callouts.scss'
import './styles/wysiwym-source.scss'
import './styles/editor-popovers.scss'
import './styles/shared.scss'
import './styles/glass.scss'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* ErrorBoundary is outermost so it catches a crash anywhere below — even
        in the provider stack — and replaces the white screen with a styled,
        reloadable state (the client's "500"). Toast/Dialog sit inside it so
        their portals are available to the whole app tree. */}
    <ErrorBoundary>
      <ToastProvider>
        <DialogProvider>
          {/* PWA lifecycle (#40): captures the install prompt at boot and raises
              the update toast — needs Toast above it, and sits around the whole
              app so it's listening before beforeinstallprompt fires. */}
          <PwaProvider>
            <App />
          </PwaProvider>
        </DialogProvider>
      </ToastProvider>
    </ErrorBoundary>
  </StrictMode>,
)
