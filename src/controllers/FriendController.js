// src/controllers/friendController.js
import logger from "../utils/logger.js";
import { captureScreenshot } from "../utils/screenshot.js";
import { wait } from "../utils/wait.js";

export default class FriendController {
  constructor(page) {
    this.page = page;
  }

  /**
   * Send a friend request by profile URL or name
   * @param {string} target - profile URL or name
   */
  async sendFriendRequest(target) {
    try {
      logger.info("Starting friend request flow", { target });

      if (target.startsWith("http")) {
        // direct profile URL
        await this.page.goto(target, { waitUntil: "domcontentloaded" });
      } else {
        // search by name
        logger.debug("Searching user by name...");
        await this.page.goto(
          "https://www.facebook.com/search/people/?q=" +
            encodeURIComponent(target),
          {
            waitUntil: "domcontentloaded",
          }
        );

        // wait for cards
        await this.page.waitForSelector(
          "a[href*='/profile.php'], a[href*='/']",
          { timeout: 10000 }
        );

        const profileLink = await this.page.$eval(
          "a[href*='/profile.php'], a[href*='/']",
          (el) => el.href
        );
        logger.info("Opening profile from search results", {
          url: profileLink,
        });

        await this.page.goto(profileLink, { waitUntil: "domcontentloaded" });
      }

      // wait for Add Friend button
      logger.debug("Looking for Add Friend button...");
      const buttonSelectors = [
        "div[aria-label='Add Friend']",
        "div[role='button'][aria-label*='Add Friend']",
        "span:has-text('Add Friend')",
        "div[aria-label*='Add Friend'] span",
      ];

      let buttonHandle = null;
      for (const sel of buttonSelectors) {
        try {
          const h = await this.page.$(sel);
          if (h) {
            buttonHandle = h;
            break;
          }
        } catch (e) {}
      }

      if (!buttonHandle) {
        logger.warn(
          "No Add Friend button found, maybe already friends or restricted"
        );
        const shot = await captureScreenshot(this.page, "no-add-friend");
        return {
          success: false,
          error: "no_add_friend_button",
          screenshot: shot.success ? shot.urlPath : null,
        };
      }

      // click button
      await buttonHandle.click();
      await wait(1000 + Math.random() * 1000);

      logger.info("Friend request sent successfully ✅");
      return { success: true };
    } catch (err) {
      logger.error("Friend request failed", { error: err.message });
      const shot = await captureScreenshot(this.page, "friend-request-error");
      return {
        success: false,
        error: err.message,
        screenshot: shot.success ? shot.urlPath : null,
      };
    }
  }
}
