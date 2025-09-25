export async function humanType(page, selectorOrHandle, text) {
  const handle =
    typeof selectorOrHandle === "string"
      ? await page.$(selectorOrHandle)
      : selectorOrHandle;
  await handle.focus();
  for (const ch of text) {
    await page.keyboard.type(ch);
    await new Promise((r) => setTimeout(r, 70 + Math.random() * 130));
  }
}

export async function delay(ms) {
  return new Promise((res) => setTimeout(res, ms));
}
export function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
