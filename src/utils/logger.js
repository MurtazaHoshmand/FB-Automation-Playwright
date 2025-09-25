// src/utils/logger.js
import fs from "fs";
import path from "path";

const logDir = path.join(process.cwd(), "logs");
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir);

function log(level, message, meta = {}) {
  const entry = { time: new Date().toISOString(), level, message, ...meta };
  const line = JSON.stringify(entry);
  console.log(line);
  fs.appendFileSync(path.join(logDir, `${level}.log`), line + "\n");
}

export default {
  info: (msg, meta) => log("info", msg, meta),
  warn: (msg, meta) => log("warn", msg, meta),
  error: (msg, meta) => log("error", msg, meta),
  debug: (msg, meta) => log("debug", msg, meta),
};
