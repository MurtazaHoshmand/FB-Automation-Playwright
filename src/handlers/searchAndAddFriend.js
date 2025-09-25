import { restoreSession, saveSession } from "../utils/session.js";
import { humanType, delay } from "../utils/helpers.js";

export default async function searchAndAddFriend(browser, { name }) {
  const page = await browser.newPage();
  await restoreSession(page, process.env.SESSION_FILE);

  await page.goto("https://www.facebook.com/", { waitUntil: "networkidle2" });

  // Top search box
  await page.waitForSelector('input[aria-label="Search Facebook"]');
  await humanType(page, 'input[aria-label="Search Facebook"]', name);
  await page.keyboard.press("Enter");

  await delay(3000);

  // Try to click "Add Friend" button in results
  const button = await page.$x("//span[contains(text(), 'Add Friend')]");
  if (button.length > 0) {
    await button[0].click();
  } else {
    throw new Error("No Add Friend button found");
  }

  await saveSession(page, process.env.SESSION_FILE);
  return { ok: true, msg: `Friend request sent to ${name}` };
}
