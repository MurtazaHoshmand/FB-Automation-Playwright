// src/utils/human.js

export async function humanType(page, handleOrSelector, text, opts = {}) {
  const { minDelay = 70, maxDelay = 140 } = opts;
  let handle;
  if (typeof handleOrSelector === "string") {
    handle = await page.$(handleOrSelector);
  } else {
    handle = handleOrSelector;
  }
  if (!handle) throw new Error("humanType: handle not found");
  await handle.focus();
  for (const ch of text) {
    // Playwright's keyboard.type will type full string; we simulate char-by-char
    await page.keyboard.type(ch);
    const delay = minDelay + Math.floor(Math.random() * (maxDelay - minDelay));
    await new Promise((r) => setTimeout(r, delay));
  }
}

export async function smallHumanMove(page) {
  try {
    const box = await page.evaluate(() => {
      const el = document.querySelector("body");
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      return { w: rect.width, h: rect.height };
    });
    if (!box) return;
    const x1 = Math.floor(box.w * 0.3 + Math.random() * box.w * 0.6);
    const y1 = Math.floor(box.h * 0.2 + Math.random() * box.h * 0.6);
    await page.mouse.move(x1, y1, { steps: 10 });
  } catch (e) {}
}
