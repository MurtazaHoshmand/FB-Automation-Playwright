import openMessages from "./handlers/openMessages.js";
import sendMessage from "./handlers/sendMessage.js";
import searchAndAddFriend from "./handlers/searchAndAddFriend.js";

export async function handleCommand(browser, method, params) {
  switch (method) {
    case "openMessages":
      return await openMessages(browser, params);
    case "sendMessage":
      return await sendMessage(browser, params);
    case "searchAndAddFriend":
      return await searchAndAddFriend(browser, params);
    default:
      throw new Error(`Unknown method: ${method}`);
  }
}
