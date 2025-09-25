import { restoreSession, saveSession } from "../utils/session.js";
import { humanType, delay } from "../utils/helpers.js";

export default async function sendMessage(browser, { to, message }) {
  const page = await browser.newPage();
  await restoreSession(page, process.env.SESSION_FILE);

  await page.goto("https://www.facebook.com/messages/t/", {
    waitUntil: "networkidle2",
  });

  // Search bar inside messenger
  await page.waitForSelector('input[aria-label="Search Messenger"]');
  await humanType(page, 'input[aria-label="Search Messenger"]', to);
  await delay(2000);

  // Click first result
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");

  // Wait for input area
  await page.waitForSelector('[aria-label="Message"]', { timeout: 10000 });
  await humanType(page, '[aria-label="Message"]', message);
  await page.keyboard.press("Enter");

  await saveSession(page, process.env.SESSION_FILE);
  return { ok: true, msg: `Message sent to ${to}` };
}
