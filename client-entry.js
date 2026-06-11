/**
 * CC Prompter — Webpack Client Entry
 *
 * This file is prepended to Next.js webpack client entries.
 * At build time, webpack DefinePlugin replaces:
 *   __CC_PROMPTER_INJECT_SCRIPT__ → inject.js content (string)
 *   __CC_PROMPTER_PORT__ → configured sidecar port (number)
 */
if (typeof window !== 'undefined') {
  // Pass the start port so inject.js can probe the sidecar
  window.__CC_PROMPTER_START_PORT__ = __CC_PROMPTER_PORT__;

  // Inject the cc-prompter script into the page
  var script = document.createElement('script');
  script.textContent = __CC_PROMPTER_INJECT_SCRIPT__;
  document.head.appendChild(script);
}
