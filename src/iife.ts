// Entry for the script tag bundle (checked.min.js). Exposes window.Checked and
// initializes itself from the tag's data attributes when data-key is present.
import { Checked } from './index'

declare global {
  interface Window {
    Checked?: typeof Checked
  }
}

try {
  if (typeof window !== 'undefined') {
    if (!window.Checked) {
      window.Checked = Checked
      Checked.autoInit()
    }
  }
} catch {
  /* never throw into the host page */
}
