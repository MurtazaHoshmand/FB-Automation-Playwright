// src/utils/waitForSelectorAny.js
export async function waitForSelectorAny(page, selectors, options = {}) {
  for (const sel of selectors) {
    try {
      const el = await page.waitForSelector(sel, { timeout: 5000, ...options });
      if (el) return el;
    } catch {
      // ignore and try next selector
    }
  }
  throw new Error(`No element found for selectors: ${selectors.join(", ")}`);
}
