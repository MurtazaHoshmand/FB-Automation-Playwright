// src/utils/session.js
import fs from "fs/promises";
import path from "path";

const SESSIONS_DIR = path.join(process.cwd(), "sessions");

async function ensureDir(dir) {
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch (e) {}
}

/**
 * Save cookies + localStorage to sessions/<name>.json
 * page: Playwright Page
 */
export async function saveSession(page, name = "default") {
  await ensureDir(SESSIONS_DIR);
  const context = page.context();
  const cookies = await context.cookies();
  const localStorageData = await page.evaluate(() => {
    const o = {};
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      o[k] = localStorage.getItem(k);
    }
    return o;
  });

  const out = {
    cookies,
    localStorage: localStorageData,
    savedAt: new Date().toISOString(),
  };
  const file = path.join(SESSIONS_DIR, `${name}.json`);
  await fs.writeFile(file, JSON.stringify(out, null, 2), "utf8");
  return file;
}

/**
 * Load session into given page (will navigate to facebook to apply cookies/localStorage)
 */
export async function loadSession(page, name = "default") {
  const file = path.join(SESSIONS_DIR, `${name}.json`);
  try {
    const raw = await fs.readFile(file, "utf8");
    const parsed = JSON.parse(raw);

    const context = page.context();

    if (parsed.cookies && parsed.cookies.length) {
      // Playwright requires cookie objects with same keys (domain, path, name, value, etc.)
      await context.addCookies(parsed.cookies).catch(() => {});
    }

    // Navigate to facebook origin and set localStorage keys (so cookies+localStorage apply)
    try {
      await page
        .goto("https://www.facebook.com", {
          waitUntil: "domcontentloaded",
          timeout: 15000,
        })
        .catch(() => {});
      await page.evaluate((data) => {
        try {
          for (const k of Object.keys(data || {})) {
            localStorage.setItem(k, data[k]);
          }
        } catch (e) {}
      }, parsed.localStorage || {});
    } catch (e) {
      // ignore
    }

    return { ok: true, file };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

export async function listSessions() {
  try {
    const items = await fs.readdir(SESSIONS_DIR);
    return items.filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
}
