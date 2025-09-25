// src/playwrightServer.js
import express from "express";
import bodyParser from "body-parser";
import path from "path";
import fs from "fs/promises";
import { chromium } from "playwright";
import FacebookController from "./controllers/facebookController.js";
import { loadSession } from "./utils/session.js";

const app = express();
app.use(bodyParser.json({ limit: "10mb" }));

// serve screenshots
app.use(
  "/screenshots",
  express.static(path.join(process.cwd(), "screenshots"))
);

let browser, context, page, fb;
let fbReady = false;

(async () => {
  // Launch Playwright Chromium
  browser = await chromium.launch({
    headless: false, // visible browser reduces chance of checkpoint in many cases
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-blink-features=AutomationControlled",
      "--window-size=1280,800",
    ],
  });

  // Create context with sane viewport and a normal userAgent
  context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    locale: "en-US",
    timezoneId: "Asia/Kabul",
  });

  // Small stealth-ish adjustments applied to every page in this context
  await context.addInitScript(() => {
    // hide webdriver
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });

    // minimal chrome object
    window.chrome = window.chrome || { runtime: {} };

    // languages
    Object.defineProperty(navigator, "languages", {
      get: () => ["en-US", "en"],
    });

    // plugins length
    Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
  });

  page = await context.newPage();
  await page.setViewportSize({ width: 1280, height: 800 });

  fb = new FacebookController(page, {
    sessionName: "default",
    minMessageIntervalMs: 10_000,
  });

  await fb.initSession();
  fbReady = true;
  console.log("Playwright driver ready.");
})().catch((e) => {
  console.error("Browser launch failed:", e);
});

// Login endpoint
app.post("/login", async (req, res) => {
  if (!fb) return res.status(503).json({ success: false, error: "not_ready" });
  const { email, password } = req.body;
  try {
    const result = await fb.login(email, password);
    if (!result.success) return res.status(400).json(result);
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// Send message
app.post("/sendMessage", async (req, res) => {
  if (!fbReady || !fb) {
    return res.status(400).json({ success: false, error: "page_not_ready" });
  }
  const { recipient, text } = req.body;
  try {
    const result = await fb.sendMessage(recipient, text, "default");
    if (!result.success) return res.status(400).json(result);
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/friendRequest", async (req, res) => {
  if (!fbReady || !fb) {
    return res.status(400).json({ success: false, error: "page_not_ready" });
  }
  const { recipient } = req.body;
  try {
    const result = await fb.sendFriendRequest(recipient);
    if (!result.success) return res.status(400).json(result);
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// Upload a session JSON (from human ops after manual login) to replace session file
app.post("/uploadSession", async (req, res) => {
  try {
    const { sessionName = "default", session } = req.body;
    if (!session)
      return res.status(400).json({ success: false, error: "no_session" });

    const sessionsDir = path.join(process.cwd(), "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });
    const filePath = path.join(sessionsDir, `${sessionName}.json`);
    await fs.writeFile(filePath, JSON.stringify(session, null, 2), "utf8");

    // load it into current page/context
    await loadSession(page, sessionName);
    return res.json({ success: true, file: filePath });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// Health
app.get("/health", (req, res) => res.json({ ok: true }));

app.listen(3000, () => console.log("Playwright API running on port 3000"));
