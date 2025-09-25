// src/utils/captcha.js
import logger from "./logger.js";
import { captureScreenshot } from "./screenshot.js";

const FRAME_PATTERNS = [/recaptcha/i, /hcaptcha/i, /captcha/i];
const SELECTOR_CANDIDATES = [
  "iframe[src*='recaptcha']",
  "iframe[src*='hcaptcha']",
  "iframe[src*='captcha']",
  "div[id*='captcha']",
  "div[class*='captcha']",
  "div[data-testid*='captcha']",
  "form[action*='checkpoint']",
  "a[href*='/checkpoint']",
  "a[href*='checkpoint']",
  // avoid overly generic selectors like div[role='dialog'] here
];

const TEXT_PATTERNS_EN = [
  "complete a challenge to verify you’re a human",
  "complete a challenge",
  "verify you’re a human",
  "verify you are a human",
  "solve a puzzle",
  "try audio challenge",
  "security check",
  "confirm your identity",
  "prove you are human",
  "type the characters you see",
  "enter the characters",
  "we just need to make sure there’s a real human",
  "to continue, verify",
  "prove it's you",
  "we detected unusual activity",
];

const TEXT_PATTERNS_FA = [
  "تأیید هویت",
  "تأیید کنید",
  "برای ادامه",
  "ما باید مطمئن شویم",
  "اثبات کنید که انسان هستید",
  "نوع کاراکترها را وارد کنید",
  "تکمیل آزمون",
  "تأیید شما",
  "بررسی امنیتی",
];

function normalize(s = "") {
  return (s || "").toLowerCase().replace(/\s+/g, " ").trim();
}

export async function detectCaptcha(page) {
  try {
    // 1) URL heuristics (fast)
    let url = "";
    try {
      url = page.url();
    } catch (e) {
      url = "";
    }
    if (
      url &&
      /checkpoint|security|login_check|login\/checkpoint|confirm/i.test(url)
    ) {
      const shot = await captureScreenshot(page, "captcha-by-url");
      logger.warn("Captcha detected by URL", { url });
      return {
        detected: true,
        method: "url",
        match: url,
        screenshot: shot.success ? shot.urlPath : null,
        snippet: null,
      };
    }

    // 2) Check frames for recaptcha/hcaptcha/captcha (works even if cross-origin)
    try {
      const frames = page.frames();
      for (const f of frames) {
        const fu = f.url() || "";
        if (FRAME_PATTERNS.some((rx) => rx.test(fu))) {
          const shot = await captureScreenshot(page, "captcha-by-frame-url");
          logger.warn("Captcha iframe detected by frame url", { frameUrl: fu });
          return {
            detected: true,
            method: "frame_url",
            match: fu,
            screenshot: shot.success ? shot.urlPath : null,
            snippet: null,
          };
        }
        // Try to read frame body text if same-origin (safe try/catch)
        try {
          const txt =
            (await f.evaluate(
              () => document.body && document.body.innerText
            )) || "";
          const n = normalize(txt);
          if (!n) continue;
          if (
            TEXT_PATTERNS_EN.some((p) => n.includes(normalize(p))) ||
            TEXT_PATTERNS_FA.some((p) => n.includes(normalize(p)))
          ) {
            const shot = await captureScreenshot(page, "captcha-by-frame-text");
            logger.warn("Captcha detected by frame text", { frameUrl: fu });
            return {
              detected: true,
              method: "frame_text",
              match: fu,
              screenshot: shot.success ? shot.urlPath : null,
              snippet: n.slice(0, 2000),
            };
          }
        } catch (e) {
          // ignore cross-origin evaluation errors
        }
      }
    } catch (e) {
      logger.debug("frame scanning failed", { err: e.message });
    }

    // 3) Strict selector checks (only ones that strongly imply captcha)
    for (const sel of SELECTOR_CANDIDATES) {
      try {
        const el = await page.$(sel);
        if (!el) continue;

        // If it's an iframe src match, that's strong evidence
        if (/iframe/i.test(sel)) {
          const shot = await captureScreenshot(
            page,
            "captcha-by-selector-iframe"
          );
          logger.warn("Captcha detected by selector (iframe)", {
            selector: sel,
          });
          return {
            detected: true,
            method: "selector",
            match: sel,
            screenshot: shot.success ? shot.urlPath : null,
            snippet: null,
          };
        }

        // check inner text of the element for patterns
        const text =
          (await page.evaluate(
            (e) => e.innerText || e.textContent || "",
            el
          )) || "";
        const ntext = normalize(text);
        if (
          TEXT_PATTERNS_EN.some((p) => ntext.includes(normalize(p))) ||
          TEXT_PATTERNS_FA.some((p) => ntext.includes(normalize(p)))
        ) {
          const shot = await captureScreenshot(
            page,
            "captcha-by-selector-text"
          );
          logger.warn("Captcha detected by selector text", { selector: sel });
          return {
            detected: true,
            method: "selector_text",
            match: sel,
            screenshot: shot.success ? shot.urlPath : null,
            snippet: ntext.slice(0, 2000),
          };
        }
      } catch (e) {
        logger.debug("selector check error", { selector: sel, err: e.message });
      }
    }

    // 4) Page body text scan (localized + english)
    let bodyText = "";
    try {
      bodyText =
        (await page.evaluate(
          () => (document.body && document.body.innerText) || ""
        )) || "";
    } catch (e) {
      bodyText = "";
    }
    const normalizedBody = normalize(bodyText);
    if (normalizedBody) {
      const patterns = [...TEXT_PATTERNS_EN, ...TEXT_PATTERNS_FA];
      for (const pattern of patterns) {
        const p = normalize(pattern);
        if (p && normalizedBody.includes(p)) {
          const shot = await captureScreenshot(page, "captcha-by-body-text");
          logger.warn("Captcha detected by page text", { pattern: p });
          return {
            detected: true,
            method: "text",
            match: p,
            screenshot: shot.success ? shot.urlPath : null,
            snippet: normalizedBody.slice(0, 2000),
          };
        }
      }
    }

    // not found
    return { detected: false };
  } catch (err) {
    logger.error("detectCaptcha unexpected error", { error: err.message });
    return { detected: false };
  }
}
