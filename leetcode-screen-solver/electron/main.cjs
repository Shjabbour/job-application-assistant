const { app, BrowserWindow, desktopCapturer, session } = require("electron");
const { writeFile } = require("node:fs/promises");
const { spawn } = require("node:child_process");
const http = require("node:http");
const path = require("node:path");

const PORT = Number(process.env.INTERVIEW_CODER_PORT || 4378);
const URL = `http://127.0.0.1:${PORT}`;
const CAPTURE_PORT = Number(process.env.INTERVIEW_CODER_NATIVE_CAPTURE_PORT || PORT + 1);
const CAPTURE_URL = `http://127.0.0.1:${CAPTURE_PORT}`;
let serverProcess = null;
let captureServer = null;

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
    env: {
      ...process.env,
      INTERVIEW_CODER_NATIVE_CAPTURE_URL: CAPTURE_URL,
    },
    stdio: "ignore",
    windowsHide: true,
  });
  serverProcess.unref();
  await waitForServer();
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        reject(new Error("Request body is too large."));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(`${JSON.stringify(body)}\n`);
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

async function captureWindowToFile(body) {
  const outputPath = typeof body.outputPath === "string" ? body.outputPath : "";
  const windowId = String(body.windowId || "");
  const width = Math.max(1280, Number(body.width || 0) || 0);
  const height = Math.max(720, Number(body.height || 0) || 0);

  if (!outputPath || !windowId) {
    throw new Error("outputPath and windowId are required.");
  }

  const sources = await desktopCapturer.getSources({
    types: ["window"],
    thumbnailSize: { width, height },
    fetchWindowIcons: false,
  });
  const source = sources.find((item) => item.id.startsWith(`window:${windowId}:`));
  if (!source || source.thumbnail.isEmpty()) {
    throw new Error("Native shell could not capture the selected app window.");
  }

  await writeFile(outputPath, source.thumbnail.toPNG());
}

function startCaptureServer() {
  if (captureServer) {
    return;
  }

  captureServer = http.createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/health") {
        sendJson(res, 200, { ok: true });
        return;
      }

      if (req.method === "POST" && req.url === "/capture-window") {
        const body = await readJsonBody(req);
        await captureWindowToFile(body);
        sendJson(res, 200, { ok: true });
        return;
      }

      sendJson(res, 404, { error: "Not found." });
    } catch (error) {
      sendJson(res, 500, { error: error.message || String(error) });
    }
  });

  captureServer.listen(CAPTURE_PORT, "127.0.0.1");
}

async function createWindow() {
  startCaptureServer();
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
  if (captureServer) {
    captureServer.close();
  }
  if (serverProcess && !serverProcess.killed) {
    serverProcess.kill();
  }
  app.quit();
});
