// src/controllers/facebookController.js
import logger from "../utils/logger.js";
import { captureScreenshot } from "../utils/screenshot.js";
import { detectCaptcha } from "../utils/captcha.js";
import { wait } from "../utils/wait.js";
import { humanType, smallHumanMove } from "../utils/human.js";
import { saveSession, loadSession } from "../utils/session.js";
// import { markBlocked, isBlocked } from "../utils/circuit.js";
// import puppeteer from "puppeteer";

export default class FacebookController {
  constructor(page, opts = {}) {
    if (!page || typeof page.goto !== "function")
      throw new Error("Invalid  page passed");
    this.page = page;
    this.opts = opts;
    this.sessionName = opts.sessionName || "default";
    this.minMessageIntervalMs = opts.minMessageIntervalMs || 1000 * 10;
    this._lastActionAt = 0;
  }

  // ensure we don't act too fast
  async throttle() {
    const now = Date.now();
    const waitFor = Math.max(
      0,
      this.minMessageIntervalMs - (now - this._lastActionAt)
    );
    if (waitFor > 0) await wait(waitFor);
    this._lastActionAt = Date.now();
  }

  async initSession() {
    // call once at startup to load cookies/localStorage if available
    try {
      await this.page.setViewport({ width: 1280, height: 800 });
      const loaded = await loadSession(this.page, this.sessionName);
      logger.info("Session loaded", loaded);
      return loaded;
    } catch (e) {
      logger.warn("Session init failed", e.message);
      return null;
    }
  }

  async persistSession() {
    try {
      const path = await saveSession(this.page, this.sessionName);
      logger.info("Session saved", path);
      return path;
    } catch (e) {
      logger.warn("Session save failed", e.message);
      return null;
    }
  }

  async login(email, password, maxRetries = 2) {
    let attempt = 0;

    // helper: poll until we see success/captcha/invalid/timeout
    const waitForLoginOutcome = async (timeoutMs = 20000) => {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        // 1) quick success check (logged-in indicator)
        try {
          // Use the same "already logged in" heuristic but be defensive: ensure it's visible
          const loggedInEl = await this.page.$("input[type='search']");
          if (loggedInEl) {
            // ensure it's visible (avoid hidden elements)
            const visible = await this.page.evaluate((el) => {
              const s = window.getComputedStyle(el);
              const r = el.getBoundingClientRect();
              return !(
                s.display === "none" ||
                s.visibility === "hidden" ||
                (r.width === 0 && r.height === 0)
              );
            }, loggedInEl);
            if (visible) return { outcome: "success" };
          }
        } catch (e) {
          /* ignore */
        }

        // 2) captcha check (fast)
        try {
          const captcha = await detectCaptcha(this.page);
          if (captcha && captcha.detected)
            return { outcome: "captcha", captcha };
        } catch (e) {
          // don't let detectCaptcha failures kill the loop
          logger.debug("detectCaptcha error in wait loop", { err: e.message });
        }

        // 3) invalid credentials check - scan body text for known strings
        try {
          const body =
            (await this.page.evaluate(
              () => document.body && document.body.innerText
            )) || "";
          const nb = (body || "").toLowerCase();
          if (
            nb.includes("incorrect") ||
            nb.includes("wrong password") ||
            nb.includes("password you entered is incorrect") ||
            nb.includes("اطلاعات ورود صحیح نمی‌باشد") ||
            nb.includes("رمز عبور")
          ) {
            return {
              outcome: "invalid_credentials",
              snippet: nb.slice(0, 800),
            };
          }
        } catch (e) {
          /* ignore */
        }

        // wait a bit before retrying checks
        await new Promise((r) => setTimeout(r, 700));
      }
      return { outcome: "timeout" };
    };

    // single attempt of the form submit
    const doLoginOnce = async () => {
      logger.info("Navigating to login page...");
      await this.page.goto("https://www.facebook.com/login", {
        waitUntil: "domcontentloaded",
      });

      // defensive already-logged-in check
      const maybeLogged = await this.page.$("input[type='search']");
      if (maybeLogged) {
        // verify visible
        const visible = await this.page
          .evaluate((el) => {
            const s = window.getComputedStyle(el);
            const r = el.getBoundingClientRect();
            return !(
              s.display === "none" ||
              s.visibility === "hidden" ||
              (r.width === 0 && r.height === 0)
            );
          }, maybeLogged)
          .catch(() => false);
        if (visible) {
          logger.info("✅ Already logged in, skipping login.");
          return { alreadyLoggedIn: true, success: true };
        }
      }

      // ensure fields exist
      await this.page.waitForSelector("#email", { timeout: 10000 });
      await this.page.waitForSelector("#pass", { timeout: 10000 });

      // type credentials
      await humanType(this.page, "#email", email);
      await humanType(this.page, "#pass", password);
      await smallHumanMove(this.page);

      // submit and then wait for a clear outcome (we don't rely solely on waitForNavigation)
      await this.page.click("[name=login]");

      const outcome = await waitForLoginOutcome(20000);
      return outcome;
    };

    while (attempt <= maxRetries) {
      try {
        logger.info(`Attempting login... (try ${attempt + 1})`);
        const outcome = await doLoginOnce();

        if (outcome.success || outcome.outcome === "success") {
          await this.persistSession();
          logger.info("Login successful");
          return { success: true };
        }

        if (outcome.alreadyLoggedIn) {
          await this.persistSession();
          logger.info("Already logged in (early return)");
          return { success: true, alreadyLoggedIn: true };
        }

        if (
          outcome.outcome === "captcha" ||
          (outcome.captcha && outcome.captcha.detected)
        ) {
          // save screenshot & log detail
          const shot = await captureScreenshot(
            this.page,
            `login-captcha-${attempt}`
          );
          logger.warn("Captcha detected during login", {
            attempt,
            detail: outcome.captcha || null,
          });

          if (attempt < maxRetries) {
            attempt++;
            // exponential backoff + jitter
            const backoff =
              Math.min(15000, 1000 * Math.pow(2, attempt)) +
              Math.floor(Math.random() * 1000);
            logger.info(`Retrying login after captcha (sleep ${backoff}ms)`);
            await new Promise((r) => setTimeout(r, backoff));
            // optionally clear cookies or reload fresh login page to reduce repeat captchas:
            try {
              await this.page.evaluate(() => {
                localStorage.clear();
                sessionStorage.clear();
              });
            } catch (e) {}
            try {
              await this.page.deleteCookie(...(await this.page.cookies()));
            } catch (e) {}
            continue;
          } else {
            logger.error("Max captcha retries reached. Giving up.");
            return {
              success: false,
              error: "captcha_detected",
              screenshot: shot.success ? shot.urlPath : null,
              detail: outcome.captcha || null,
            };
          }
        }

        if (outcome.outcome === "invalid_credentials") {
          logger.error("Invalid credentials detected on login attempt", {
            attempt,
            snippet: outcome.snippet,
          });
          return {
            success: false,
            error: "invalid_credentials",
            detail: outcome.snippet || null,
          };
        }

        if (outcome.outcome === "timeout") {
          logger.warn("Login attempt timed out without clear outcome", {
            attempt,
          });
          if (attempt < maxRetries) {
            attempt++;
            await new Promise((r) =>
              setTimeout(r, 1000 + Math.random() * 1000)
            );
            continue;
          } else {
            return { success: false, error: "timeout" };
          }
        }

        // Unknown case: fail safe
        logger.error("Unknown login outcome", { outcome });
        return { success: false, error: "unknown_outcome", detail: outcome };
      } catch (err) {
        logger.error("Login failed with exception", { error: err.message });
        return { success: false, error: err.message };
      }
    }

    // fallback if loop exits
    return { success: false, error: "max_retries_exceeded" };
  }

  // async login(email, password, maxRetries = 2) {
  //   let attempt = 0;

  //   const doLoginOnce = async () => {
  //     logger.info("Navigating to login page...");
  //     await this.page.goto("https://www.facebook.com/login", {
  //       waitUntil: "domcontentloaded",
  //     });

  //     // check if already logged in
  //     const loggedIn = await this.page.$("input[type='search']");
  //     if (loggedIn) {
  //       logger.info("✅ Already logged in, skipping login.");
  //       return { success: true, alreadyLoggedIn: true };
  //     }

  //     // ensure fields
  //     await this.page.waitForSelector("#email", { timeout: 10000 });
  //     await this.page.waitForSelector("#pass", { timeout: 10000 });

  //     // type creds
  //     await humanType(this.page, "#email", email);
  //     await humanType(this.page, "#pass", password);
  //     await smallHumanMove(this.page);

  //     await Promise.all([
  //       this.page.click("[name=login]"),
  //       this.page
  //         .waitForNavigation({ waitUntil: "domcontentloaded", timeout: 20000 })
  //         .catch(() => {}),
  //     ]);

  //     // detect captcha
  //     const captcha = await detectCaptcha(this.page);

  //     return { captcha, success: !captcha.detected };
  //   };

  //   while (attempt <= maxRetries) {
  //     try {
  //       logger.info(`Attempting login... (try ${attempt + 1})`);
  //       const result = await doLoginOnce();

  //       if (result.success) {
  //         await this.persistSession();
  //         logger.info("Login successful");
  //         return { success: true };
  //       }

  //       // captcha detected
  //       logger.warn("Captcha detected during login", {
  //         attempt,
  //         detail: result.captcha,
  //       });
  //       const shot = await captureScreenshot(
  //         this.page,
  //         `login-captcha-${attempt}`
  //       );

  //       if (attempt < maxRetries) {
  //         attempt++;
  //         logger.info("Retrying login after captcha...");
  //         await wait(1000 + Math.random() * 1000);
  //         continue; // go back to while loop
  //       } else {
  //         logger.error("Max captcha retries reached. Giving up.");
  //         return {
  //           success: false,
  //           error: "captcha_detected",
  //           screenshot: shot.success ? shot.urlPath : null,
  //           detail: result.captcha,
  //         };
  //       }
  //     } catch (err) {
  //       logger.error("Login failed", { error: err.message });
  //       return { success: false, error: err.message };
  //     }
  //   }
  // }

  // async login(email, password, maxRetries = 2) {
  //   let attempt = 0;

  //   while (attempt <= maxRetries) {
  //     try {
  //       logger.info(`Attempting login... (try ${attempt + 1})`);

  //       await this.page.goto("https://www.facebook.com/login", {
  //         waitUntil: "domcontentloaded",
  //       });

  //       // Check if already logged in
  //       const loggedIn = await this.page.$("input[type='search']");
  //       if (loggedIn) {
  //         logger.info("✅ Already logged in, skipping login.");
  //         return { success: true, alreadyLoggedIn: true };
  //       }

  //       // ensure fields exist
  //       await this.page.waitForSelector("#email", { timeout: 10000 });
  //       await this.page.waitForSelector("#pass", { timeout: 10000 });

  //       // type credentials
  //       await humanType(this.page, "#email", email);
  //       await humanType(this.page, "#pass", password);
  //       await smallHumanMove(this.page);

  //       await Promise.all([
  //         this.page.click("[name=login]"),
  //         this.page
  //           .waitForNavigation({
  //             waitUntil: "domcontentloaded",
  //             timeout: 20000,
  //           })
  //           .catch(() => {}),
  //       ]);

  //       // detect captcha
  //       const captcha = await detectCaptcha(this.page);
  //       if (captcha.detected) {
  //         logger.warn("Captcha detected during login", {
  //           attempt,
  //           detail: captcha,
  //         });
  //         const shot = await captureScreenshot(
  //           this.page,
  //           `login-captcha-${attempt}`
  //         );

  //         // retry logic
  //         if (attempt < maxRetries) {
  //           attempt++;
  //           logger.info("Retrying login after captcha...");
  //           await wait(1000 + Math.random() * 1000); // small delay before retry
  //           await this.page.goto("https://www.facebook.com/login", {
  //             waitUntil: "domcontentloaded",
  //           });

  //           // Check if already logged in
  //           const loggedIn = await this.page.$("input[type='search']");
  //           if (loggedIn) {
  //             logger.info("✅ Already logged in, skipping login.");
  //             return { success: true, alreadyLoggedIn: true };
  //           }

  //           // ensure fields exist
  //           await this.page.waitForSelector("#email", { timeout: 10000 });
  //           await this.page.waitForSelector("#pass", { timeout: 10000 });

  //           // type credentials
  //           await humanType(this.page, "#email", email);
  //           await humanType(this.page, "#pass", password);
  //           await smallHumanMove(this.page);

  //           await Promise.all([
  //             this.page.click("[name=login]"),
  //             this.page
  //               .waitForNavigation({
  //                 waitUntil: "domcontentloaded",
  //                 timeout: 20000,
  //               })
  //               .catch(() => {}),
  //           ]);
  //           continue;
  //         } else {
  //           logger.error("Max captcha retries reached. Giving up.");
  //           return {
  //             success: false,
  //             error: "captcha_detected",
  //             screenshot: shot.success ? shot.urlPath : null,
  //             detail: captcha,
  //           };
  //         }
  //       }

  //       // if no captcha → success
  //       await this.persistSession();
  //       logger.info("Login successful");
  //       return { success: true };
  //     } catch (err) {
  //       logger.error("Login failed", { error: err.message });
  //       return { success: false, error: err.message };
  //     }
  //   }
  // }

  // async sendMessage(recipient, text) {
  //   try {
  //     logger.info("sendMessage start", { recipient });
  //     await wait(1000 + Math.random() * 2000);
  //     await this.throttle();

  //     // 1) Go directly to Facebook search results
  //     const searchUrl = `https://www.facebook.com/search/top?q=${encodeURIComponent(
  //       recipient
  //     )}`;
  //     logger.debug("Navigating to search results", { url: searchUrl });
  //     await this.page.goto(searchUrl, { waitUntil: "domcontentloaded" });
  //     await wait(1500 + Math.random() * 1500);

  //     // 2) Look for candidate profile cards
  //     logger.debug("Looking for profile cards...");
  //     const recipientEscaped = JSON.stringify(recipient);
  //     const cardXpath = `xpath=//div[contains(@role,'feed')]//a[.//span[contains(normalize-space(.), ${recipientEscaped})]]`;
  //     const cards = await this.page.$$(cardXpath);

  //     if (!cards || cards.length === 0) {
  //       logger.error("No profile card found for recipient", { recipient });
  //       return { success: false, error: "no_profile_card" };
  //     }

  //     // 3) Click the first candidate
  //     logger.info("Clicking recipient profile from search results");
  //     await cards[0].click();
  //     await this.page.waitForNavigation({ waitUntil: "domcontentloaded" });
  //     await wait(1200 + Math.random() * 1500);

  //     // 4) Locate & click "Message" button on profile
  //     logger.debug("Looking for 'Message' button...");
  //     const messageButton = await this.page.$x(
  //       "//a[contains(@href,'/messages/t/') or contains(., 'Message') or contains(., 'پیام')]"
  //     );

  //     if (!messageButton || messageButton.length === 0) {
  //       logger.error("Message button not found");
  //       return { success: false, error: "no_message_button" };
  //     }

  //     await messageButton[0].click();
  //     logger.info("Clicked Message button, waiting for chat to open...");
  //     await this.page.waitForNavigation({ waitUntil: "domcontentloaded" });
  //     await wait(1500 + Math.random() * 1500);

  //     // 5) Find message input
  //     logger.debug("Locating chat message input...");
  //     const messageSelectors = [
  //       "div[contenteditable='true'][role='textbox']",
  //       "div[aria-label='Message']",
  //       "div[aria-label='Write a message']",
  //     ];
  //     let messageHandle = null;
  //     for (const sel of messageSelectors) {
  //       messageHandle = await this.page.$(sel);
  //       if (messageHandle) {
  //         logger.info("Found message input", { selector: sel });
  //         break;
  //       }
  //     }

  //     if (!messageHandle) {
  //       logger.error("No message input found in chat window");
  //       return { success: false, error: "no_message_input" };
  //     }

  //     // 6) Type and send the message
  //     await messageHandle.focus();
  //     await humanType(this.page, messageHandle, text);
  //     await this.page.keyboard.press("Enter");
  //     await wait(800 + Math.random() * 1200);

  //     logger.info("Message successfully sent", { recipient });
  //     await this.persistSession();
  //     return { success: true };
  //   } catch (err) {
  //     logger.error("sendMessage exception", { error: err.message });
  //     return { success: false, error: err.message };
  //   }
  // }

  async sendMessage(recipient, text, accountKey = this.sessionName) {
    try {
      logger.info("sendMessage start", { recipient });
      await wait(1000 + Math.random() * 2000);
      await this.throttle();

      // 1) Try messenger page first
      logger.debug("Navigating to messenger...");
      await this.page.goto("https://www.facebook.com/messages/t/", {
        waitUntil: "domcontentloaded",
      });
      logger.debug("Messenger page loaded", { url: this.page.url() });

      // login check
      const loginFields = await this.page.$(
        "#email, input[name='email'], input[type='password']"
      );
      if (loginFields) {
        logger.warn(
          "Not logged in - login fields detected after visiting messenger"
        );
        const shot = await captureScreenshot(this.page, "not-logged-in");
        return {
          success: false,
          error: "not_logged_in",
          screenshot: shot.success ? shot.urlPath : null,
        };
      }

      // early captcha check
      // const captchaEarly = await detectCaptcha(this.page);
      // if (captchaEarly.detected) {
      //   logger.warn("Captcha detected early on messenger", {
      //     detail: captchaEarly,
      //   });
      //   const shot = await captureScreenshot(this.page, "captcha-before-send");
      //   return {
      //     success: false,
      //     error: "captcha_detected",
      //     screenshot: shot.success ? shot.urlPath : null,
      //     detail: captchaEarly,
      //   };
      // }

      // wait for messenger UI
      logger.debug("Waiting for messenger UI container...");
      await this.page
        .waitForSelector("div[role='main'], div[role='dialog']", {
          timeout: 15000,
        })
        .catch(() => {});
      logger.debug("Messenger main container present");

      // 2) Try messenger search input
      const searchSelectors = [
        'input[aria-label="Search Messenger"]',
        'input[placeholder*="Search Messenger"]',
        'input[placeholder*="Search"]',
        'input[aria-label*="Search"]',
        'input[type="search"]',
        'input[role="combobox"]',
      ];

      let searchHandle = null;
      let usedSearchSel = null;
      for (const sel of searchSelectors) {
        try {
          const h = await this.page.$(sel);
          if (h) {
            searchHandle = h;
            usedSearchSel = sel;
            break;
          }
        } catch (e) {}
      }

      if (searchHandle) {
        logger.info("Messenger search input found", {
          selector: usedSearchSel,
        });
        await searchHandle.click({ clickCount: 3 }).catch(() => {});
        await this.page.keyboard.press("Backspace").catch(() => {});
        await humanType(this.page, searchHandle, recipient);
        await this.page.keyboard.press("Enter").catch(() => {});
        await wait(1200 + Math.random() * 2200);

        // try to click result in messenger
        logger.debug("Looking for messenger-side results...");
        const recipientEscaped = JSON.stringify(recipient);

        // messenger: look for clickable rows containing recipient
        const rowXpath = `xpath=//div[@role='option' or @role='row' or @role='listitem']//span[contains(normalize-space(.), ${recipientEscaped})]`;
        let rowSpans = await this.page.$$(rowXpath);

        if (rowSpans && rowSpans.length > 0) {
          logger.info("Found messenger-side result rows", {
            count: rowSpans.length,
          });
          // click clickable ancestor for the first match
          let opened = false;
          for (const span of rowSpans) {
            try {
              const ancestorHandle = await span.evaluateHandle((el) =>
                el.closest(
                  '[role="option"], [role="row"], [role="listitem"], a, button'
                )
              );
              const ancestorEl =
                ancestorHandle && ancestorHandle.asElement
                  ? ancestorHandle.asElement()
                  : null;
              if (ancestorEl) {
                await ancestorEl.click().catch(() => {});
                opened = true;
                logger.debug("Clicked result ancestor in messenger");
                break;
              } else {
                await span.click().catch(() => {});
                opened = true;
                logger.debug("Clicked span fallback in messenger");
                break;
              }
            } catch (e) {
              logger.debug("Click attempt on messenger candidate failed", {
                err: e.message,
              });
            }
          }

          if (opened) {
            logger.info("Opened chat via messenger result");
            // continue to message input detection below
          } else {
            logger.debug("Failed to open chat from messenger rows");
          }
        } else {
          logger.debug("No messenger-side rows matched exact recipient");
        }
      } else {
        logger.debug(
          "No messenger search input found; will try global search fallback"
        );
      }

      // 3) If chat not opened by messenger search, try global search results page
      // Check if chat input is present already (maybe opened)
      let inputExists = await this.page.$(
        "div[contenteditable='true'][role='textbox'], div[aria-label='Message']"
      );
      if (!inputExists) {
        logger.debug(
          "Message input not present yet; attempting global search page fallback"
        );

        // Go to facebook search results for the recipient
        const searchUrl = `https://www.facebook.com/search/top?q=${encodeURIComponent(
          recipient
        )}`;
        logger.debug("Navigating to global search results", { url: searchUrl });
        await this.page
          .goto(searchUrl, { waitUntil: "domcontentloaded" })
          .catch(() => {});
        await wait(1200 + Math.random() * 1600);

        logger.debug(
          "Searching for profile cards containing recipient name..."
        );
        const recipientEscaped = JSON.stringify(recipient);
        // Find card elements that contain the recipient name (broad)
        const cardXpath = `xpath=//div[.//span[contains(normalize-space(.), ${recipientEscaped})] or .//a//span[contains(normalize-space(.), ${recipientEscaped})]]`;
        const cards = await this.page.$$(cardXpath);

        logger.debug("Candidate profile cards found count", {
          count: cards.length,
        });

        let clicked = false;
        if (cards && cards.length > 0) {
          for (const card of cards) {
            try {
              // Look for clickable elements inside the card that indicate "Message" or have messages href
              const candidates = await card.$$(
                'a, button, div[role="button"], span[role="button"]'
              );
              for (const c of candidates) {
                try {
                  const txt = (
                    await c.evaluate((el) => (el.innerText || "").toLowerCase())
                  ).trim();
                  const href = await c.evaluate((el) =>
                    el.getAttribute ? el.getAttribute("href") || "" : ""
                  );
                  if (
                    txt &&
                    (txt.includes("پیام") ||
                      txt.includes("message") ||
                      txt.includes("send message") ||
                      txt.includes("پیغام"))
                  ) {
                    logger.info(
                      "Clicking message-like button inside profile card",
                      { text: txt.slice(0, 60) }
                    );
                    await c.click().catch(() => {});
                    clicked = true;
                    break;
                  }
                  if (href && href.includes("/messages/t/")) {
                    logger.info("Clicking messages href inside profile card", {
                      href,
                    });
                    await c.click().catch(() => {});
                    clicked = true;
                    break;
                  }
                } catch (e) {
                  // ignore candidate failure
                }
              }
              if (clicked) break;
            } catch (e) {
              logger.debug(
                "Error while scanning a profile card for message button",
                { err: e.message }
              );
            }
          }
        }

        if (!clicked) {
          logger.warn(
            "No clickable 'Message' button found in global search results"
          );
          const shot = await captureScreenshot(this.page, "no-clickable-row");
          return {
            success: false,
            error: "no_clickable_row",
            screenshot: shot.success ? shot.urlPath : null,
          };
        }

        logger.info(
          "Clicked 'Message' on global search result, waiting for chat to open"
        );
        await wait(800 + Math.random() * 1200);
      } else {
        logger.debug("Message input already present (chat likely open)");
      }
      // ========================================================
      // 4) Locate message input in chat area
      // logger.debug("Locating message input in chat dialog...");
      // const messageSelectors = [
      //   "div[contenteditable='true'][role='textbox']",
      //   "div[role='textbox'][contenteditable='true']",
      //   "div[aria-label='Message']",
      //   "div[aria-label='Write a message']",
      //   "div[contenteditable='true']",
      // ];

      // let messageHandle = null;
      // let usedSelector = null;
      // for (const sel of messageSelectors) {
      //   try {
      //     const h = await this.page.$(sel);
      //     if (h) {
      //       messageHandle = h;
      //       usedSelector = sel;
      //       break;
      //     }
      //   } catch (e) {}
      // }

      //  if (!messageHandle) {
      //   logger.error("Message input not found after opening chat");
      //   const shot = await captureScreenshot(this.page, "no-message-input");
      //   return {
      //     success: false,
      //     error: "no_message_input",
      //     screenshot: shot.success ? shot.urlPath : null,
      //   };
      // }
      // logger.info("Found message input", { selector: usedSelector });

      // =============================================================
      // helper to find a visible element handle that is likely the messenger message input

      // usage: after you click "Message" and log "waiting for chat to open"
      logger.debug("Locating message input in chat dialog...");
      const messageHandle = await this.findMessageInputHandle(this.page, 10000);
      if (!messageHandle) {
        logger.error("Message input not found after opening chat");
        const shot = await captureScreenshot(this.page, "no-message-input");
        return {
          success: false,
          error: "no_message_input",
          screenshot: shot.success ? shot.urlPath : null,
        };
      }
      logger.info("Found message input (will focus and type)...");

      // ===========================

      // 5) Type and send the message (human-like)
      await messageHandle.focus();
      await smallHumanMove(this.page);
      logger.debug("Typing message...");
      await humanType(this.page, messageHandle, text);
      await this.page.keyboard.press("Enter");
      await wait(400 + Math.random() * 700);
      logger.info("Message typed and sent");

      // 6) Final captcha check
      // const captchaAfter = await detectCaptcha(this.page);
      // if (captchaAfter.detected) {
      //   logger.warn("Captcha detected after sending", { detail: captchaAfter });
      //   const shot = await captureScreenshot(this.page, "captcha-after-send");
      //   return {
      //     success: false,
      //     error: "captcha_after_send",
      //     screenshot: shot.success ? shot.urlPath : null,
      //     detail: captchaAfter,
      //   };
      // }

      // 7) Persist session & success
      await this.persistSession();
      logger.info("sendMessage success", { recipient });
      return { success: true };
    } catch (err) {
      logger.error("sendMessage exception", {
        error: err.message,
        stack: err.stack,
      });
      try {
        const shot = await captureScreenshot(
          this.page,
          "sendMessage-exception"
        );
        return {
          success: false,
          error: err.message,
          screenshot: shot.success ? shot.urlPath : null,
        };
      } catch (e) {
        return { success: false, error: err.message };
      }
    }
  }

  // async sendFriendRequest(profileName) {
  //   try {
  //     logger.info("sendFriendRequest start", { profileName });
  //     await wait(1000 + Math.random() * 2000);
  //     await this.throttle();

  //     // 1) Go to search page for the profile
  //     const searchUrl = `https://www.facebook.com/search/top?q=${encodeURIComponent(
  //       profileName
  //     )}`;
  //     logger.debug("Navigating to search results", { url: searchUrl });
  //     await this.page.goto(searchUrl, { waitUntil: "domcontentloaded" });
  //     await wait(1500 + Math.random() * 1500);

  //     // 2) Look for candidate profile cards
  //     const profileEscaped = JSON.stringify(profileName);
  //     const cardXpath = `xpath=//div[contains(@role,'feed')]//a[.//span[contains(normalize-space(.), ${profileEscaped})]]`;
  //     const cards = await this.page.$$(cardXpath);

  //     if (!cards || cards.length === 0) {
  //       logger.error("No profile card found for profileName", { profileName });
  //       return { success: false, error: "no_profile_card" };
  //     }

  //     // 3) Click the first candidate
  //     logger.info("Clicking profile from search results");
  //     await cards[0].click();
  //     await this.page.waitForNavigation({ waitUntil: "domcontentloaded" });
  //     await wait(1200 + Math.random() * 1500);

  //     // 4) Locate & click "Add Friend" button
  //     logger.debug("Looking for 'Add Friend' button...");
  //     const addFriendButtons = await this.page.$x(
  //       "//div[@role='button' and (contains(., 'Add Friend') or contains(., 'افزودن دوست'))]"
  //     );

  //     if (!addFriendButtons || addFriendButtons.length === 0) {
  //       logger.warn("Add Friend button not found", { profileName });
  //       return { success: false, error: "no_add_friend_button" };
  //     }

  //     await addFriendButtons[0].click();
  //     logger.info("Clicked 'Add Friend' button", { profileName });
  //     await wait(1000 + Math.random() * 1500);

  //     // 5) Confirm request was sent (optional: detect button change to 'Friend Request Sent')
  //     let requestConfirmed = false;
  //     try {
  //       requestConfirmed = await this.page.evaluate(() => {
  //         const btns = Array.from(
  //           document.querySelectorAll("div[role='button']")
  //         );
  //         return btns.some((el) => {
  //           const txt = (el.innerText || "").toLowerCase();
  //           return (
  //             txt.includes("cancel request") ||
  //             txt.includes("friend request sent")
  //           );
  //         });
  //       });
  //     } catch (e) {
  //       logger.debug("Could not confirm request visually", { err: e.message });
  //     }

  //     await this.persistSession();
  //     return {
  //       success: true,
  //       requestConfirmed,
  //       profile: profileName,
  //     };
  //   } catch (err) {
  //     logger.error("sendFriendRequest exception", { error: err.message });
  //     try {
  //       const shot = await captureScreenshot(
  //         this.page,
  //         "sendFriendRequest-exception"
  //       );
  //       return {
  //         success: false,
  //         error: err.message,
  //         screenshot: shot.success ? shot.urlPath : null,
  //       };
  //     } catch (e) {
  //       return { success: false, error: err.message };
  //     }
  //   }
  // }

  async sendFriendRequest(profileName) {
    try {
      logger.info("sendFriendRequest start", { profileName });
      await wait(1000 + Math.random() * 2000);
      await this.throttle();

      // 1) Go to search page for the profile
      const searchUrl = `https://www.facebook.com/search/top?q=${encodeURIComponent(
        profileName
      )}`;
      logger.debug("Navigating to search results", { url: searchUrl });
      await this.page.goto(searchUrl, { waitUntil: "domcontentloaded" });
      await wait(1500 + Math.random() * 1500);

      // 2) Look for candidate profile cards
      const profileEscaped = JSON.stringify(profileName);
      const cardXpath = `xpath=//div[contains(@role,'feed')]//a[.//span[contains(normalize-space(.), ${profileEscaped})]]`;
      const cards = await this.page.$$(cardXpath);

      // if (!cards || cards.length === 0) {
      //   logger.error("No profile card found for profileName", { profileName });
      //   return {
      //     status: "failed",
      //     message: "No profile card found",
      //     error: "no_profile_card",
      //   };
      // }

      // =========
      // Find first "Add friend" button
      const addFriendBtn = await this.page.$(
        "div[aria-label='Add friend'][role='button']"
      );

      if (!addFriendBtn) {
        logger.error("No 'Add friend' button found");
        return {
          status: "failed",
          message: "No 'Add friend' button found",
          error: "no_add_friend_button",
        };
      }

      // Click it
      await addFriendBtn.click();
      logger.info("Clicked 'Add friend' button");
      await wait(1500 + Math.random() * 1000);

      // // 3) Click the first candidate
      // logger.info("Clicking profile from search results");
      // await cards[0].click();
      // await this.page.waitForNavigation({ waitUntil: "domcontentloaded" });
      // await wait(1200 + Math.random() * 1500);

      // 4) Check if already friends
      const alreadyFriend = await this.page.evaluate(() => {
        const btns = Array.from(
          document.querySelectorAll("div[role='button']")
        );
        return btns.some((el) => {
          const txt = (el.innerText || "").toLowerCase();
          return (
            txt.includes("friends") ||
            txt.includes("دوست شدید") || // Farsi UI
            txt.includes("already friends")
          );
        });
      });

      if (alreadyFriend) {
        logger.info("User is already a friend", { profileName });
        return {
          status: "success",
          message: "Already friends with this user",
          error: null,
          profile: profileName,
        };
      }

      // 5) Locate & click "Add Friend" button
      // logger.debug("Looking for 'Add Friend' button...");
      // const addFriendButtons = await this.page.$x(
      //   "//div[@role='button' and (contains(., 'Add Friend') or contains(., 'افزودن دوست'))]"
      // );

      // if (!addFriendButtons || addFriendButtons.length === 0) {
      //   logger.warn("Add Friend button not found", { profileName });
      //   return {
      //     status: "failed",
      //     message: "Add Friend button not found",
      //     error: "no_add_friend_button",
      //     profile: profileName,
      //   };
      // }

      await addFriendButtons[0].click();
      logger.info("Clicked 'Add Friend' button", { profileName });
      await wait(1000 + Math.random() * 1500);

      // 6) Confirm request was sent
      let requestConfirmed = false;
      try {
        requestConfirmed = await this.page.evaluate(() => {
          const btns = Array.from(
            document.querySelectorAll("div[role='button']")
          );
          return btns.some((el) => {
            const txt = (el.innerText || "").toLowerCase();
            return (
              txt.includes("cancel request") ||
              txt.includes("friend request sent") ||
              txt.includes("درخواست دوستی ارسال شد") // Farsi UI
            );
          });
        });
      } catch (e) {
        logger.debug("Could not confirm request visually", { err: e.message });
      }

      await this.persistSession();

      return {
        status: "success",
        message: requestConfirmed
          ? "Friend request sent and confirmed"
          : "Friend request sent (unconfirmed)",
        error: null,
        profile: profileName,
      };
    } catch (err) {
      logger.error("sendFriendRequest exception", { error: err.message });
      try {
        const shot = await captureScreenshot(
          this.page,
          "sendFriendRequest-exception"
        );
        return {
          status: "failed",
          message: "Exception while sending friend request",
          error: err.message,
          screenshot: shot.success ? shot.urlPath : null,
          profile: profileName,
        };
      } catch (e) {
        return {
          status: "failed",
          message: "Exception while sending friend request",
          error: err.message,
          profile: profileName,
        };
      }
    }
  }

  async findMessageInputHandle(page, overallTimeout = 5000) {
    const selectors = [
      "div[contenteditable='true'][role='textbox']",
      "div[role='textbox'][contenteditable='true']",
      "div[data-lexical-editor='true'][contenteditable='true']",
      "div[aria-label='Message']",
      "div[aria-label='Write a message']",
      "div[aria-label='پیام']", // Persian aria-label seen in your screenshot
      "div[contenteditable='plaintext-only']",
      "div[contenteditable='true']",
      "textarea",
      "input[type='text']",
    ];

    const start = Date.now();
    // Try simple waitForSelector attempts with short timeouts first (faster success)
    for (const sel of selectors) {
      const remaining = Math.max(0, overallTimeout - (Date.now() - start));
      if (!remaining) break;
      try {
        // visible:true ensures the element is displayed
        const handle = await page.waitForSelector(sel, {
          visible: true,
          timeout: Math.min(2000, remaining),
        });
        if (handle) return handle;
      } catch (e) {
        // ignore and continue
      }
    }

    // Fallback: query all contenteditable nodes and pick the first visible one that looks like a textbox
    // This runs inside the page and returns the DOM node (as a JSHandle)
    try {
      const remaining = Math.max(0, overallTimeout - (Date.now() - start));
      if (remaining <= 0) return null;
      const handle = await page.waitForFunction(
        () => {
          const nodes = Array.from(
            document.querySelectorAll(
              '[contenteditable], textarea, input[type="text"]'
            )
          );
          function isVisible(el) {
            if (!el) return false;
            const style = window.getComputedStyle(el);
            const rect = el.getBoundingClientRect();
            if (style.visibility === "hidden" || style.display === "none")
              return false;
            if (rect.width === 0 && rect.height === 0) return false;
            if (el.closest('[aria-hidden="true"]')) return false;
            return true;
          }
          const candidates = nodes.filter((e) => {
            if (!isVisible(e)) return false;
            const aria = (e.getAttribute && e.getAttribute("aria-label")) || "";
            if (e.getAttribute("role") === "textbox") return true;
            if (e.dataset && e.dataset.lexicalEditor === "true") return true;
            // check for localized 'message' words
            if (/message|پیام|write/i.test(aria)) return true;
            // last fallback: visible contenteditable
            return e.getAttribute && e.getAttribute("contenteditable") != null;
          });
          return candidates.length ? candidates[0] : false;
        },
        { timeout: remaining }
      );

      // waitForFunction returns the element handle only as the JSHandle result; get a handle reference:
      const jsHandle = await page.evaluateHandle(() => {
        const nodes = Array.from(
          document.querySelectorAll(
            '[contenteditable], textarea, input[type="text"]'
          )
        );
        function isVisible(el) {
          if (!el) return false;
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          if (style.visibility === "hidden" || style.display === "none")
            return false;
          if (rect.width === 0 && rect.height === 0) return false;
          if (el.closest('[aria-hidden="true"]')) return false;
          return true;
        }
        const candidates = nodes.filter((e) => {
          if (!isVisible(e)) return false;
          const aria = (e.getAttribute && e.getAttribute("aria-label")) || "";
          if (e.getAttribute("role") === "textbox") return true;
          if (e.dataset && e.dataset.lexicalEditor === "true") return true;
          if (/message|پیام|write/i.test(aria)) return true;
          return e.getAttribute && e.getAttribute("contenteditable") != null;
        });
        return candidates.length ? candidates[0] : null;
      });

      // verify we have an element
      const element = jsHandle.asElement ? jsHandle.asElement() : null;
      if (element) return element;
    } catch (e) {
      // fallback failed — return null
    }

    return null;
  }
}
