const { app, BrowserWindow, desktopCapturer, ipcMain, session } = require("electron");
const http = require("node:http");
const path = require("node:path");

app.setPath("userData", path.join(app.getPath("appData"), "Interview Coder Smoke"));

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

async function main() {
  const sources = await desktopCapturer.getSources({
    types: ["window", "screen"],
    thumbnailSize: { width: 1280, height: 720 },
    fetchWindowIcons: true,
  });
  const source = preferSource(sources);
  console.log(JSON.stringify({
    sourceCount: sources.length,
    selected: source ? { id: source.id, name: source.name } : null,
    sourceNames: sources.map((item) => item.name).slice(0, 20),
  }, null, 2));

  if (!source) {
    throw new Error("No desktop capture sources were available.");
  }

  session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
    callback({ video: source });
  }, { useSystemPicker: false });

  ipcMain.handle("capture-result", (_event, result) => result);

  const testServer = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`
      <html><body><script>
        const { ipcRenderer } = require('electron');
        async function run() {
          if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
            throw new Error('getDisplayMedia is not available.');
          }
          const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
          const video = document.createElement('video');
          video.muted = true;
          video.srcObject = stream;
          await video.play();
          if (!video.videoWidth || !video.videoHeight) {
            await new Promise((resolve) => video.onloadedmetadata = resolve);
          }
          await new Promise((resolve) => setTimeout(resolve, 500));
          const canvas = document.createElement('canvas');
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(video, 0, 0);
          const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
          const stepX = Math.max(1, Math.floor(canvas.width / 64));
          const stepY = Math.max(1, Math.floor(canvas.height / 64));
          let min = 255, max = 0, count = 0;
          for (let y = 0; y < canvas.height; y += stepY) {
            for (let x = 0; x < canvas.width; x += stepX) {
              const i = (y * canvas.width + x) * 4;
              const lum = data[i] * 0.2126 + data[i + 1] * 0.7152 + data[i + 2] * 0.0722;
              min = Math.min(min, lum);
              max = Math.max(max, lum);
              count += 1;
            }
          }
          stream.getTracks().forEach((track) => track.stop());
          return ipcRenderer.invoke('capture-result', {
            width: canvas.width,
            height: canvas.height,
            luminanceRange: max - min,
            nonblank: count > 0 && max - min >= 12,
          });
        }
        run().then((result) => {
          document.title = JSON.stringify(result);
        }).catch((error) => {
          document.title = JSON.stringify({ error: error.message || String(error) });
        });
      </script></body></html>
    `);
  });
  await new Promise((resolve) => testServer.listen(0, "127.0.0.1", resolve));
  const address = testServer.address();
  const testUrl = `http://127.0.0.1:${address.port}`;

  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      sandbox: false,
    },
  });

  await win.loadURL(testUrl);

  try {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      const title = win.getTitle();
      if (title.startsWith("{")) {
        const result = JSON.parse(title);
        console.log(JSON.stringify(result, null, 2));
        if (result.error) {
          throw new Error(result.error);
        }
        if (!result.nonblank) {
          throw new Error(`Capture source returned blank pixels (${result.width}x${result.height}, range ${result.luminanceRange}).`);
        }
        return;
      }
    }

    throw new Error("Timed out waiting for renderer capture result.");
  } finally {
    testServer.close();
  }
}

app.whenReady()
  .then(main)
  .then(() => app.quit())
  .catch((error) => {
    console.error(error);
    app.quit();
    process.exitCode = 1;
  });
