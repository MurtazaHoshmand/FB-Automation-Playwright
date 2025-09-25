import { restoreSession, saveSession } from "../utils/session.js";

export default async function openMessages(browser, params) {
  const page = await browser.newPage();
  await restoreSession(page, process.env.SESSION_FILE);

  await page.goto("https://www.facebook.com/messages/t/", {
    waitUntil: "networkidle2",
  });

  await page.waitForTimeout(3000);
  await saveSession(page, process.env.SESSION_FILE);

  return { ok: true, msg: "Messages page opened" };
}
