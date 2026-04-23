import { createWorker, type Worker } from "tesseract.js";

let workerPromise: Promise<Worker> | null = null;

async function getWorker(): Promise<Worker> {
  if (!workerPromise) {
    workerPromise = (async () => {
      const worker = await createWorker("eng");
      return worker;
    })();
  }

  return workerPromise;
}

function normalizeText(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function readImageText(imagePath: string): Promise<string> {
  const worker = await getWorker();
  const result = await worker.recognize(imagePath);
  return normalizeText(result.data.text ?? "");
}

export async function shutdownOcrWorker(): Promise<void> {
  if (!workerPromise) {
    return;
  }

  const worker = await workerPromise;
  await worker.terminate();
  workerPromise = null;
}
