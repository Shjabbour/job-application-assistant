const { app, BrowserWindow, desktopCapturer, session } = require("electron");
const { spawn } = require("node:child_process");
const http = require("node:http");
const path = require("node:path");

const PORT = Number(process.env.INTERVIEW_CODER_PORT || 4378);
const URL = `http://127.0.0.1:${PORT}`;
let serverProcess = null;

app.setPath("userData", path.join(app.getPath("appData"), "Interview Coder Native"));

function isServerReady() {
  return new Promise((resolve) => {
    const req = http.get(`${URL}/api/runs`, (res) => {
      res.resume();
      resolve(res.statusCode && res.statusCode < 500);
    });
    req.on("error", () => resolve(false));
    req.setTimeout(750, () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function waitForServer() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (await isServerReady()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Interview Coder UI did not start at ${URL}`);
}

async function ensureServer() {
  if (await isServerReady()) {
    return;
  }

  const command = process.platform === "win32" ? "cmd.exe" : "npm";
  const args = process.platform === "win32"
    ? ["/c", "npm", "run", "ui", "--", "--port", String(PORT)]
    : ["run", "ui", "--", "--port", String(PORT)];
  serverProcess = spawn(command, args, {
    cwd: path.resolve(__dirname, ".."),
    env: process.env,
    stdio: "ignore",
    windowsHide: true,
  });
  serverProcess.unref();
  await waitForServer();
}

function preferSource(sources) {
  const normalized = sources
    .map((source) => ({
      source,
      name: String(source.name || "").toLowerCase(),
    }))
    .filter((item) => !item.name.includes("interview coder"));

  return (
    normalized.find((item) => item.name.includes("chrome remote desktop"))?.source ||
    normalized.find((item) => item.name.includes("remote desktop"))?.source ||
    normalized.find((item) => item.source.id.startsWith("window:"))?.source ||
    normalized[0]?.source ||
    sources[0]
  );
}

function installCaptureHandler() {
  session.defaultSession.setDisplayMediaRequestHandler(
    async (_request, callback) => {
      try {
        const sources = await desktopCapturer.getSources({
          types: ["window", "screen"],
          thumbnailSize: { width: 1280, height: 720 },
          fetchWindowIcons: true,
        });
        const source = preferSource(sources);
        if (!source) {
          callback({});
          return;
        }
        callback({ video: source });
      } catch (_error) {
        callback({});
      }
    },
    { useSystemPicker: false },
  );
}

async function createWindow() {
  await ensureServer();
  installCaptureHandler();

  const win = new BrowserWindow({
    width: 1500,
    height: 920,
    title: "Interview Coder",
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  await win.loadURL(`${URL}/?native=1`);
}

app.whenReady().then(createWindow).catch((error) => {
  console.error(error);
  app.quit();
});

app.on("window-all-closed", () => {
  if (serverProcess && !serverProcess.killed) {
    serverProcess.kill();
  }
  app.quit();
});
