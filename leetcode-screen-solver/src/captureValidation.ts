import { readFile, stat } from "node:fs/promises";

interface ImageInfo {
  format: "png" | "jpeg" | "webp";
  width: number;
  height: number;
}

function readPngInfo(buffer: Buffer): ImageInfo | null {
  if (buffer.length < 24 || buffer.toString("hex", 0, 8) !== "89504e470d0a1a0a") {
    return null;
  }

  return {
    format: "png",
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

function readWebpInfo(buffer: Buffer): ImageInfo | null {
  if (buffer.length < 30 || buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WEBP") {
    return null;
  }

  const chunk = buffer.toString("ascii", 12, 16);
  if (chunk === "VP8X" && buffer.length >= 30) {
    return {
      format: "webp",
      width: 1 + buffer.readUIntLE(24, 3),
      height: 1 + buffer.readUIntLE(27, 3),
    };
  }

  return null;
}

function readJpegInfo(buffer: Buffer): ImageInfo | null {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
    return null;
  }

  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }

    const marker = buffer[offset + 1];
    const length = buffer.readUInt16BE(offset + 2);
    if (length < 2) {
      return null;
    }

    if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb)) {
      return {
        format: "jpeg",
        height: buffer.readUInt16BE(offset + 5),
        width: buffer.readUInt16BE(offset + 7),
      };
    }

    offset += 2 + length;
  }

  return null;
}

function readImageInfo(buffer: Buffer): ImageInfo | null {
  return readPngInfo(buffer) ?? readJpegInfo(buffer) ?? readWebpInfo(buffer);
}

export async function assertUsableCapture(imagePath: string): Promise<void> {
  const fileStat = await stat(imagePath);
  if (!fileStat.isFile() || fileStat.size < 1024) {
    throw new Error("Capture failed: the screenshot file is empty or too small.");
  }

  const buffer = await readFile(imagePath);
  const info = readImageInfo(buffer);
  if (!info) {
    throw new Error("Capture failed: the saved file is not a readable screenshot image.");
  }

  if (info.width < 160 || info.height < 120) {
    throw new Error(`Capture failed: screenshot is only ${info.width}x${info.height}. Choose the interview window/screen again.`);
  }
}
