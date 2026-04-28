const { app, desktopCapturer } = require("electron");
const { writeFile } = require("node:fs/promises");

function normalize(value) {
  return String(value || "").toLowerCase();
}

app.whenReady().then(async () => {
  const outputPath = process.env.LEETCODE_SOLVER_SCREENSHOT_PATH;
  const windowId = process.env.LEETCODE_SOLVER_WINDOW_ID;
  const width = Math.max(1280, Number(process.env.LEETCODE_SOLVER_WINDOW_WIDTH || 0) || 0);
  const height = Math.max(720, Number(process.env.LEETCODE_SOLVER_WINDOW_HEIGHT || 0) || 0);

  if (!outputPath || !windowId) {
    throw new Error("LEETCODE_SOLVER_SCREENSHOT_PATH and LEETCODE_SOLVER_WINDOW_ID are required.");
  }

  const sources = await desktopCapturer.getSources({
    types: ["window"],
    thumbnailSize: { width, height },
    fetchWindowIcons: false,
  });
  const source = sources.find((item) => item.id.startsWith(`window:${windowId}:`))
    || sources.find((item) => normalize(item.name).includes("chrome remote desktop"))
    || sources.find((item) => normalize(item.name).includes("remote desktop"));

  if (!source || source.thumbnail.isEmpty()) {
    throw new Error("Electron could not capture the selected app window.");
  }

  await writeFile(outputPath, source.thumbnail.toPNG());
  app.quit();
}).catch((error) => {
  console.error(error.message || error);
  app.exit(1);
});
