// Shared Chromium launcher for the tests and scripts.
//
// By default Playwright uses the browser it downloaded (`npx playwright
// install chromium`). Set CHROMIUM_PATH to use another Chromium/Chrome binary
// instead, e.g. a system install or a CI image's preinstalled browser.
import { chromium } from 'playwright';

export function launchChromium(options = {}) {
  const executablePath = process.env.CHROMIUM_PATH || undefined;
  return chromium.launch({ ...options, ...(executablePath ? { executablePath } : {}) });
}
