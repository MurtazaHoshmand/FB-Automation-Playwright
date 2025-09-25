// src/utils/wait.js
export function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
