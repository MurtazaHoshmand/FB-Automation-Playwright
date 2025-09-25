import { createServer } from "http";
import WebSocket, { WebSocketServer } from "ws";
import dotenv from "dotenv";
import { startBrowser } from "./utils/stealth.js";
import { handleCommand } from "./controller.js";

dotenv.config();

const PORT = process.env.PORT || 8080;
const AUTH_TOKEN = process.env.AUTH_TOKEN;

let browser;

async function main() {
  browser = await startBrowser();
  const server = createServer();
  const wss = new WebSocketServer({ server });

  wss.on("connection", (ws, req) => {
    // Simple auth via query string ?token=
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.searchParams.get("token") !== AUTH_TOKEN) {
      ws.close();
      return;
    }

    ws.on("message", async (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
        const { id, method, params } = msg;
        const result = await handleCommand(browser, method, params);
        ws.send(JSON.stringify({ id, result }));
      } catch (err) {
        ws.send(
          JSON.stringify({
            id: msg?.id || null,
            error: err.message || "Unknown error",
          })
        );
      }
    });
  });

  server.listen(PORT, () => {
    console.log(
      `✅ Puppeteer controller running on ws://localhost:${PORT}?token=***`
    );
  });
}

main();
