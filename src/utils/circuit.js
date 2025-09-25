// src/utils/screenshot.js
import fs from "fs/promises";
import path from "path";

export async function captureScreenshot(page, label = "screenshot") {
  const baseDir = path.join(process.cwd(), "screenshots");
  const dateDir = new Date().toISOString().split("T")[0];
  const dir = path.join(baseDir, dateDir);
  await fs.mkdir(dir, { recursive: true }).catch(() => {});
  const filename = `${label}-${Date.now()}.png`;
  const filePath = path.join(dir, filename);

  try {
    // ensure viewport not zero
    await page.setViewport({ width: 1280, height: 800 }).catch(() => {});
    await new Promise((r) => setTimeout(r, 200));
    await page.screenshot({ path: filePath, fullPage: true });
    return {
      success: true,
      path: filePath,
      urlPath: `/screenshots/${dateDir}/${filename}`,
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}
