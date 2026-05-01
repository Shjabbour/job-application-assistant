import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export type DictationInput = "pc" | "microphone";

export interface DictationResult {
  text: string;
  input: DictationInput;
}

const LOOPBACK_SPEECH_RECOGNIZER_CS = String.raw`using System;
using System.Collections.Concurrent;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Speech.AudioFormat;
using System.Speech.Recognition;
using System.Threading;

namespace InterviewCoderAudio {
  [ComImport]
  [Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
  internal class MMDeviceEnumeratorComObject { }

  internal enum EDataFlow { eRender = 0, eCapture = 1, eAll = 2 }
  internal enum ERole { eConsole = 0, eMultimedia = 1, eCommunications = 2 }
  internal enum AUDCLNT_SHAREMODE { AUDCLNT_SHAREMODE_SHARED = 0, AUDCLNT_SHAREMODE_EXCLUSIVE = 1 }

  [Flags]
  internal enum AudioClientBufferFlags : uint { None = 0, DataDiscontinuity = 1, Silent = 2, TimestampError = 4 }

  [StructLayout(LayoutKind.Sequential, Pack = 2)]
  internal struct WAVEFORMATEX {
    public ushort wFormatTag;
    public ushort nChannels;
    public uint nSamplesPerSec;
    public uint nAvgBytesPerSec;
    public ushort nBlockAlign;
    public ushort wBitsPerSample;
    public ushort cbSize;
  }

  [StructLayout(LayoutKind.Sequential, Pack = 2)]
  internal struct WAVEFORMATEXTENSIBLE {
    public WAVEFORMATEX Format;
    public ushort wValidBitsPerSample;
    public uint dwChannelMask;
    public Guid SubFormat;
  }

  [ComImport]
  [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6")]
  [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  internal interface IMMDeviceEnumerator {
    [PreserveSig] int EnumAudioEndpoints(EDataFlow dataFlow, uint dwStateMask, out IntPtr ppDevices);
    void GetDefaultAudioEndpoint(EDataFlow dataFlow, ERole role, out IMMDevice ppEndpoint);
    [PreserveSig] int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string pwstrId, out IMMDevice ppDevice);
    [PreserveSig] int RegisterEndpointNotificationCallback(IntPtr pClient);
    [PreserveSig] int UnregisterEndpointNotificationCallback(IntPtr pClient);
  }

  [ComImport]
  [Guid("D666063F-1587-4E43-81F1-B948E807363F")]
  [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  internal interface IMMDevice {
    void Activate(ref Guid iid, uint dwClsCtx, IntPtr pActivationParams, [MarshalAs(UnmanagedType.IUnknown)] out object ppInterface);
    [PreserveSig] int OpenPropertyStore(uint stgmAccess, out IntPtr ppProperties);
    [PreserveSig] int GetId([MarshalAs(UnmanagedType.LPWStr)] out string ppstrId);
    [PreserveSig] int GetState(out uint pdwState);
  }

  [ComImport]
  [Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2")]
  [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  internal interface IAudioClient {
    void Initialize(AUDCLNT_SHAREMODE shareMode, uint streamFlags, long hnsBufferDuration, long hnsPeriodicity, IntPtr pFormat, IntPtr audioSessionGuid);
    void GetBufferSize(out uint pNumBufferFrames);
    void GetStreamLatency(out long phnsLatency);
    void GetCurrentPadding(out uint pNumPaddingFrames);
    [PreserveSig] int IsFormatSupported(AUDCLNT_SHAREMODE shareMode, IntPtr pFormat, out IntPtr ppClosestMatch);
    void GetMixFormat(out IntPtr ppDeviceFormat);
    void GetDevicePeriod(out long phnsDefaultDevicePeriod, out long phnsMinimumDevicePeriod);
    void Start();
    void Stop();
    void Reset();
    void SetEventHandle(IntPtr eventHandle);
    void GetService(ref Guid riid, [MarshalAs(UnmanagedType.IUnknown)] out object ppv);
  }

  [ComImport]
  [Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317")]
  [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  internal interface IAudioCaptureClient {
    void GetBuffer(out IntPtr ppData, out uint pNumFramesToRead, out AudioClientBufferFlags pdwFlags, out ulong pu64DevicePosition, out ulong pu64QPCPosition);
    void ReleaseBuffer(uint numFramesRead);
    void GetNextPacketSize(out uint pNumFramesInNextPacket);
  }

  internal sealed class BlockingAudioStream : Stream {
    private readonly BlockingCollection<byte[]> buffers = new BlockingCollection<byte[]>(new ConcurrentQueue<byte[]>());
    private byte[] current = new byte[0];
    private int offset;
    private long position;

    public void Add(byte[] buffer) {
      if (buffer == null || buffer.Length == 0 || buffers.IsAddingCompleted) return;
      try { buffers.Add(buffer); } catch (InvalidOperationException) { }
    }

    public void Complete() {
      if (!buffers.IsAddingCompleted) buffers.CompleteAdding();
    }

    public override bool CanRead { get { return true; } }
    public override bool CanSeek { get { return false; } }
    public override bool CanWrite { get { return false; } }
    public override long Length { get { return long.MaxValue; } }
    public override long Position { get { return position; } set { position = value; } }
    public override void Flush() { }
    public override long Seek(long offset, SeekOrigin origin) { return position; }
    public override void SetLength(long value) { }
    public override void Write(byte[] buffer, int offset, int count) { throw new NotSupportedException(); }

    public override int Read(byte[] buffer, int targetOffset, int count) {
      while (true) {
        if (offset < current.Length) {
          int copied = Math.Min(count, current.Length - offset);
          Buffer.BlockCopy(current, offset, buffer, targetOffset, copied);
          offset += copied;
          position += copied;
          return copied;
        }
        try {
          current = buffers.Take();
          offset = 0;
        } catch (InvalidOperationException) {
          return 0;
        }
      }
    }

    protected override void Dispose(bool disposing) {
      if (disposing) {
        Complete();
        buffers.Dispose();
      }
      base.Dispose(disposing);
    }
  }

  internal sealed class LoopbackCapture : IDisposable {
    private const uint CLSCTX_ALL = 23;
    private const uint AUDCLNT_STREAMFLAGS_LOOPBACK = 0x00020000;
    private static readonly Guid IID_IAudioClient = new Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2");
    private static readonly Guid IID_IAudioCaptureClient = new Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317");
    private static readonly Guid KSDATAFORMAT_SUBTYPE_IEEE_FLOAT = new Guid("00000003-0000-0010-8000-00aa00389b71");

    private readonly BlockingAudioStream stream;
    private IAudioClient audioClient;
    private IAudioCaptureClient captureClient;
    private Thread thread;
    private volatile bool stopRequested;
    private WAVEFORMATEX format;
    private bool isFloat;
    private int silenceBytes;

    public int SampleRate { get { return (int)format.nSamplesPerSec; } }

    public LoopbackCapture(BlockingAudioStream stream) {
      this.stream = stream;
      Initialize();
    }

    private void Initialize() {
      var enumerator = (IMMDeviceEnumerator)(new MMDeviceEnumeratorComObject());
      IMMDevice device;
      enumerator.GetDefaultAudioEndpoint(EDataFlow.eRender, ERole.eMultimedia, out device);
      object audioClientObject;
      var iid = IID_IAudioClient;
      device.Activate(ref iid, CLSCTX_ALL, IntPtr.Zero, out audioClientObject);
      audioClient = (IAudioClient)audioClientObject;

      IntPtr formatPtr;
      audioClient.GetMixFormat(out formatPtr);
      try {
        format = (WAVEFORMATEX)Marshal.PtrToStructure(formatPtr, typeof(WAVEFORMATEX));
        if (format.wFormatTag == 0xFFFE && format.cbSize >= 22) {
          var extensible = (WAVEFORMATEXTENSIBLE)Marshal.PtrToStructure(formatPtr, typeof(WAVEFORMATEXTENSIBLE));
          isFloat = extensible.SubFormat == KSDATAFORMAT_SUBTYPE_IEEE_FLOAT;
          format = extensible.Format;
        } else {
          isFloat = format.wFormatTag == 3;
        }
        if (format.nChannels == 0 || format.nSamplesPerSec == 0 || format.nBlockAlign == 0) {
          throw new InvalidOperationException("The default output audio format is not usable.");
        }
        silenceBytes = Math.Max(2, ((int)format.nSamplesPerSec / 100) * 2);
        audioClient.Initialize(AUDCLNT_SHAREMODE.AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK, 10000000, 0, formatPtr, IntPtr.Zero);
      } finally {
        Marshal.FreeCoTaskMem(formatPtr);
      }

      object captureObject;
      var captureIid = IID_IAudioCaptureClient;
      audioClient.GetService(ref captureIid, out captureObject);
      captureClient = (IAudioCaptureClient)captureObject;
    }

    public void Start() {
      stopRequested = false;
      audioClient.Start();
      thread = new Thread(CaptureLoop);
      thread.IsBackground = true;
      thread.Start();
    }

    private void CaptureLoop() {
      try {
        while (!stopRequested) {
          bool wrotePacket = false;
          uint packetFrames;
          captureClient.GetNextPacketSize(out packetFrames);
          while (packetFrames > 0) {
            IntPtr data;
            uint frames;
            AudioClientBufferFlags flags;
            ulong devicePosition;
            ulong qpcPosition;
            captureClient.GetBuffer(out data, out frames, out flags, out devicePosition, out qpcPosition);
            try {
              byte[] converted = ((flags & AudioClientBufferFlags.Silent) == AudioClientBufferFlags.Silent)
                ? new byte[Math.Max(2, (int)frames * 2)]
                : ConvertPacket(data, frames);
              stream.Add(converted);
              wrotePacket = true;
            } finally {
              captureClient.ReleaseBuffer(frames);
            }
            captureClient.GetNextPacketSize(out packetFrames);
          }
          if (!wrotePacket) stream.Add(new byte[silenceBytes]);
          Thread.Sleep(10);
        }
      } finally {
        stream.Complete();
      }
    }

    private byte[] ConvertPacket(IntPtr data, uint frames) {
      int channels = Math.Max(1, (int)format.nChannels);
      int sourceBytesPerSample = Math.Max(1, (int)format.wBitsPerSample / 8);
      int blockAlign = Math.Max((int)format.nBlockAlign, channels * sourceBytesPerSample);
      byte[] output = new byte[(int)frames * 2];
      for (int frame = 0; frame < frames; frame++) {
        double sum = 0;
        for (int channel = 0; channel < channels; channel++) {
          IntPtr samplePtr = IntPtr.Add(data, frame * blockAlign + channel * sourceBytesPerSample);
          sum += ReadSample(samplePtr, sourceBytesPerSample);
        }
        double mono = Math.Max(-1.0, Math.Min(1.0, sum / channels));
        short sample = (short)Math.Round(mono * short.MaxValue);
        output[frame * 2] = (byte)(sample & 0xff);
        output[frame * 2 + 1] = (byte)((sample >> 8) & 0xff);
      }
      return output;
    }

    private double ReadSample(IntPtr samplePtr, int sourceBytesPerSample) {
      if (isFloat && sourceBytesPerSample >= 4) {
        byte[] bytes = new byte[4];
        Marshal.Copy(samplePtr, bytes, 0, 4);
        return BitConverter.ToSingle(bytes, 0);
      }
      if (sourceBytesPerSample == 2) return Marshal.ReadInt16(samplePtr) / 32768.0;
      if (sourceBytesPerSample == 3) {
        int value = Marshal.ReadByte(samplePtr) | (Marshal.ReadByte(samplePtr, 1) << 8) | (Marshal.ReadByte(samplePtr, 2) << 16);
        if ((value & 0x800000) != 0) value |= unchecked((int)0xff000000);
        return value / 8388608.0;
      }
      if (sourceBytesPerSample >= 4) return Marshal.ReadInt32(samplePtr) / 2147483648.0;
      return (Marshal.ReadByte(samplePtr) - 128) / 128.0;
    }

    public void Dispose() {
      stopRequested = true;
      try { if (thread != null && !thread.Join(1000)) thread.Join(1000); } catch { }
      try { if (audioClient != null) audioClient.Stop(); } catch { }
      if (captureClient != null) Marshal.FinalReleaseComObject(captureClient);
      if (audioClient != null) Marshal.FinalReleaseComObject(audioClient);
    }
  }

  public static class LoopbackSpeechRecognizer {
    public static string Recognize(int timeoutMs) {
      timeoutMs = Math.Max(1000, Math.Min(15000, timeoutMs));
      using (var stream = new BlockingAudioStream())
      using (var capture = new LoopbackCapture(stream))
      using (var engine = new SpeechRecognitionEngine(CultureInfo.GetCultureInfo("en-US"))) {
        engine.LoadGrammar(new DictationGrammar());
        engine.SetInputToAudioStream(stream, new SpeechAudioFormatInfo(capture.SampleRate, AudioBitsPerSample.Sixteen, AudioChannel.Mono));
        capture.Start();
        RecognitionResult result = engine.Recognize(TimeSpan.FromMilliseconds(timeoutMs));
        return result == null || result.Text == null ? "" : result.Text.Trim();
      }
    }
  }
}`;

export function normalizeDictationInput(value: unknown): DictationInput {
  return value === "microphone" ? "microphone" : "pc";
}

function boundedTimeout(timeoutMs: number): number {
  return Math.max(1000, Math.min(15000, Math.round(timeoutMs)));
}

function parsePowerShellJson(stdout: string): Record<string, unknown> {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const jsonLine = [...lines].reverse().find((line) => line.startsWith("{") && line.endsWith("}"));
  if (!jsonLine) {
    throw new Error("Dictation did not return JSON.");
  }
  return JSON.parse(jsonLine) as Record<string, unknown>;
}

async function runPowerShellJson(
  script: string,
  env: Record<string, string>,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const tempDir = await mkdtemp(path.join(tmpdir(), "interview-coder-dictation-"));
  const scriptPath = path.join(tempDir, "dictation.ps1");
  await writeFile(scriptPath, script, "utf8");

  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      const child = spawn(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Sta", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
        {
          env: {
            ...process.env,
            ...env,
          },
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        },
      );

      let out = "";
      let err = "";
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        child.kill();
        reject(new Error("Dictation timed out."));
      }, timeoutMs);

      child.stdout.on("data", (chunk: Buffer) => {
        out += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk: Buffer) => {
        err += chunk.toString("utf8");
      });
      child.on("error", (error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        reject(error);
      });
      child.on("close", (code) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        if (code === 0) {
          resolve(out);
          return;
        }
        reject(new Error(err.trim() || `Dictation exited with code ${code}.`));
      });
    });

    const payload = parsePowerShellJson(stdout);
    if (typeof payload.error === "string" && payload.error.trim()) {
      throw new Error(payload.error.trim());
    }
    return payload;
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function recognizeMicrophoneOnce(timeoutMs: number): Promise<{ text: string }> {
  const safeTimeoutMs = boundedTimeout(timeoutMs);
  const script = String.raw`
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$engine = $null
try {
  Add-Type -AssemblyName System.Speech
  $culture = [System.Globalization.CultureInfo]::GetCultureInfo("en-US")
  $engine = New-Object System.Speech.Recognition.SpeechRecognitionEngine($culture)
  $engine.SetInputToDefaultAudioDevice()
  $grammar = New-Object System.Speech.Recognition.DictationGrammar
  $engine.LoadGrammar($grammar)
  $timeout = [TimeSpan]::FromMilliseconds([int]$env:INTERVIEW_CODER_DICTATION_TIMEOUT_MS)
  $result = $engine.Recognize($timeout)
  $text = if ($result -and $result.Text) { $result.Text } else { "" }
  [Console]::WriteLine((@{ text = $text } | ConvertTo-Json -Compress))
} catch {
  [Console]::WriteLine((@{ error = $_.Exception.Message } | ConvertTo-Json -Compress))
} finally {
  if ($engine -ne $null) {
    $engine.Dispose()
  }
}
`;

  const payload = await runPowerShellJson(
    script,
    { INTERVIEW_CODER_DICTATION_TIMEOUT_MS: String(safeTimeoutMs) },
    safeTimeoutMs + 7000,
  );
  return { text: typeof payload.text === "string" ? payload.text.trim() : "" };
}

async function recognizePcAudioOnce(timeoutMs: number): Promise<{ text: string }> {
  const safeTimeoutMs = boundedTimeout(timeoutMs);
  const script = String.raw`
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
try {
  Add-Type -ReferencedAssemblies System.Speech -TypeDefinition @"
${LOOPBACK_SPEECH_RECOGNIZER_CS}
"@
  $text = [InterviewCoderAudio.LoopbackSpeechRecognizer]::Recognize([int]$env:INTERVIEW_CODER_DICTATION_TIMEOUT_MS)
  [Console]::WriteLine((@{ text = $text } | ConvertTo-Json -Compress))
} catch {
  [Console]::WriteLine((@{ error = $_.Exception.Message } | ConvertTo-Json -Compress))
}
`;

  const payload = await runPowerShellJson(
    script,
    { INTERVIEW_CODER_DICTATION_TIMEOUT_MS: String(safeTimeoutMs) },
    safeTimeoutMs + 20000,
  );
  return { text: typeof payload.text === "string" ? payload.text.trim() : "" };
}

export async function recognizeSpeechOnce(timeoutMs: number, input: DictationInput): Promise<DictationResult> {
  if (process.platform !== "win32") {
    throw new Error("Native dictation is only available on Windows.");
  }

  const normalizedInput = normalizeDictationInput(input);
  const result =
    normalizedInput === "microphone"
      ? await recognizeMicrophoneOnce(timeoutMs)
      : await recognizePcAudioOnce(timeoutMs);

  return {
    input: normalizedInput,
    text: result.text,
  };
}
