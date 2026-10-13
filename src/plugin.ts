// Voice input for OpenCode Web through Lens.
// Captures microphone audio in the browser, splits it into phrases at short
// pauses, and sends each phrase as WAV to an OpenAI-compatible transcription
// endpoint through Lens (POST /__lens/stt). Text appears phrase by phrase while
// you keep talking. Audio never leaves your own machines.

const STATE_KEY = "__opencodeWebVoicePlugin";
const TRANSCRIBE_URL = "/__lens/stt";
const DEFAULT_MODEL = "mlx-community/whisper-large-v3-turbo";
// Override the model per browser with:
// localStorage.setItem("opencode-voice-stt-model", "<model name>")
const MODEL_STORAGE_KEY = "opencode-voice-stt-model";

// Phrase detection. Times in milliseconds, levels as RMS of samples in [-1, 1].
const WINDOW_MS = 20; // loudness is measured over windows of this length
const SILENCE_MS = 700; // a pause this long ends a phrase
const MIN_SPEECH_MS = 250; // shorter bursts (clicks, coughs) are dropped
const MAX_PHRASE_MS = 25_000; // long monologues are cut at this length
const PREROLL_MS = 300; // audio kept from just before speech starts
const MIN_LEVEL = 0.015; // never treat anything quieter than this as speech
const NOISE_RATIO = 3; // speech must be this many times louder than background
const TARGET_RATE = 16_000; // sample rate sent to the transcription server

const TAP_PROCESSOR = `
class OpencodeVoiceTap extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel) this.port.postMessage(channel.slice(0));
    return true;
  }
}
registerProcessor("opencode-voice-tap", OpencodeVoiceTap);
`;

type VoiceWindow = Window & {
  [STATE_KEY]?: { cleanup: () => void };
};

const voiceWindow = window as VoiceWindow;

type Phase = "idle" | "starting" | "listening" | "finishing";

type Capture = {
  context: AudioContext;
  stream: MediaStream;
  source: MediaStreamAudioSourceNode;
  tap: AudioWorkletNode;
  sink: GainNode;
  rate: number;
};

type Detector = {
  preroll: Float32Array[];
  prerollSamples: number;
  phrase: Float32Array[];
  phraseSamples: number;
  inPhrase: boolean;
  speechMs: number;
  silenceMs: number;
  noise: number;
  windowSum: number;
  windowCount: number;
};

type State = {
  phase: Phase;
  session: number;
  capture?: Capture;
  detector: Detector;
  queue: Promise<void>;
  pending: number;
  inserted: number;
  abort?: AbortController;
  button?: HTMLButtonElement;
  style?: HTMLStyleElement;
  observer?: MutationObserver;
};

function freshDetector(): Detector {
  return {
    preroll: [],
    prerollSamples: 0,
    phrase: [],
    phraseSamples: 0,
    inPhrase: false,
    speechMs: 0,
    silenceMs: 0,
    noise: 0.005,
    windowSum: 0,
    windowCount: 0,
  };
}

const state: State = {
  phase: "idle",
  session: 0,
  detector: freshDetector(),
  queue: Promise.resolve(),
  pending: 0,
  inserted: 0,
};

function main() {
  voiceWindow[STATE_KEY]?.cleanup();

  injectStyle();
  attachWhenReady();

  state.observer = new MutationObserver(attachWhenReady);
  state.observer.observe(document.documentElement, { childList: true, subtree: true });

  voiceWindow[STATE_KEY] = { cleanup };
}

function attachWhenReady() {
  const form = document.querySelector<HTMLElement>(
    '[data-component="session-composer"], [data-component="session-new-composer"], [data-component="session-prompt-dock"]',
  );
  if (!form || form.querySelector("[data-opencode-voice-input]")) return;

  const actions = form.querySelector<HTMLElement>('[data-action="prompt-attach"]')?.parentElement;
  const button = document.createElement("button");
  button.type = "button";
  button.dataset.opencodeVoiceInput = "true";
  button.className = "opencode-web-voice-plugin-button";
  button.title = "Voice input";
  button.setAttribute("aria-label", "Start voice input");
  button.innerHTML = `
    <span class="opencode-web-voice-plugin-sr-only">Voice Input</span>
    <svg aria-hidden="true" viewBox="0 0 20 20" fill="none" class="opencode-web-voice-plugin-icon">
      <path d="M10 2.5a2.5 2.5 0 0 0-2.5 2.5v4a2.5 2.5 0 0 0 5 0v-4A2.5 2.5 0 0 0 10 2.5Z" stroke="currentColor" stroke-width="1.5"/>
      <path d="M5 8.5a5 5 0 0 0 10 0M10 13.5v4M7.5 17.5h5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
    </svg>
  `;
  button.addEventListener("click", toggleRecording);

  if (actions) {
    actions.insertBefore(button, actions.firstChild);
  } else {
    form.appendChild(button);
  }

  state.button = button;
  updateButton();
}

async function toggleRecording() {
  if (state.phase === "listening") {
    await stopListening();
    return;
  }
  if (state.phase !== "idle") return;

  if (
    !navigator.mediaDevices?.getUserMedia ||
    typeof AudioContext === "undefined" ||
    typeof AudioWorkletNode === "undefined"
  ) {
    showStatus(
      "Microphone capture is not available here. Open OpenCode Web over HTTPS or localhost.",
      true,
    );
    return;
  }

  state.phase = "starting";
  state.session += 1;
  state.detector = freshDetector();
  state.inserted = 0;
  state.abort = new AbortController();
  updateButton();

  try {
    state.capture = await startCapture(state.session);
  } catch (error) {
    teardownCapture();
    state.phase = "idle";
    updateButton();
    showStatus(`Microphone access failed: ${errorMessage(error)}`, true);
    return;
  }

  state.phase = "listening";
  updateButton();
  showListening();
}

async function startCapture(session: number): Promise<Capture> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  const context = new AudioContext();
  try {
    await context.resume();
    const moduleUrl = URL.createObjectURL(
      new Blob([TAP_PROCESSOR], { type: "application/javascript" }),
    );
    try {
      await context.audioWorklet.addModule(moduleUrl);
    } finally {
      URL.revokeObjectURL(moduleUrl);
    }
    const source = context.createMediaStreamSource(stream);
    const tap = new AudioWorkletNode(context, "opencode-voice-tap");
    const sink = context.createGain();
    sink.gain.value = 0; // keeps the graph running without playing anything
    tap.port.onmessage = (event: MessageEvent<Float32Array>) => {
      if (state.session === session && state.phase === "listening") onSamples(event.data);
    };
    source.connect(tap);
    tap.connect(sink);
    sink.connect(context.destination);
    return { context, stream, source, tap, sink, rate: context.sampleRate };
  } catch (error) {
    stream.getTracks().forEach((track) => track.stop());
    void context.close();
    throw error;
  }
}

function onSamples(samples: Float32Array) {
  const capture = state.capture;
  if (!capture) return;
  const detector = state.detector;

  if (detector.inPhrase) {
    detector.phrase.push(samples);
    detector.phraseSamples += samples.length;
  } else {
    detector.preroll.push(samples);
    detector.prerollSamples += samples.length;
    const keep = (PREROLL_MS / 1000) * capture.rate;
    while (detector.prerollSamples - (detector.preroll[0]?.length ?? 0) > keep) {
      detector.prerollSamples -= detector.preroll.shift()!.length;
    }
  }

  for (let i = 0; i < samples.length; i++) detector.windowSum += samples[i] * samples[i];
  detector.windowCount += samples.length;
  if (detector.windowCount >= (WINDOW_MS / 1000) * capture.rate) {
    const level = Math.sqrt(detector.windowSum / detector.windowCount);
    detector.windowSum = 0;
    detector.windowCount = 0;
    onWindow(level, capture.rate);
  }
}

function onWindow(level: number, rate: number) {
  const detector = state.detector;
  const loud = level > Math.max(MIN_LEVEL, detector.noise * NOISE_RATIO);

  if (!detector.inPhrase) {
    if (loud) {
      detector.inPhrase = true;
      detector.phrase = detector.preroll;
      detector.phraseSamples = detector.prerollSamples;
      detector.preroll = [];
      detector.prerollSamples = 0;
      detector.speechMs = WINDOW_MS;
      detector.silenceMs = 0;
    } else {
      // Slowly follow the background level while nobody is speaking.
      detector.noise = detector.noise * 0.95 + level * 0.05;
    }
    return;
  }

  if (loud) {
    detector.speechMs += WINDOW_MS;
    detector.silenceMs = 0;
  } else {
    detector.silenceMs += WINDOW_MS;
  }

  const phraseMs = (detector.phraseSamples / rate) * 1000;
  if (detector.silenceMs >= SILENCE_MS || phraseMs >= MAX_PHRASE_MS) endPhrase();
}

function endPhrase() {
  const capture = state.capture;
  const detector = state.detector;
  if (!capture || !detector.inPhrase) return;

  const chunks = detector.phrase;
  const total = detector.phraseSamples;
  const speechMs = detector.speechMs;
  detector.inPhrase = false;
  detector.phrase = [];
  detector.phraseSamples = 0;
  detector.speechMs = 0;
  detector.silenceMs = 0;

  if (speechMs < MIN_SPEECH_MS) return;

  const samples = new Float32Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    samples.set(chunk, offset);
    offset += chunk.length;
  }
  enqueue(encodeWav(samples, capture.rate));
}

function enqueue(wav: Blob) {
  const session = state.session;
  const signal = state.abort?.signal;
  state.pending += 1;
  showListening();
  state.queue = state.queue
    .then(() => transcribe(wav, session, signal))
    .finally(() => {
      state.pending -= 1;
      if (state.session === session && state.phase === "listening") showListening();
    });
}

async function transcribe(wav: Blob, session: number, signal?: AbortSignal) {
  if (signal?.aborted) return;
  const form = new FormData();
  form.append("file", wav, "phrase.wav");
  form.append("model", sttModel());
  form.append("response_format", "json");

  try {
    const response = await fetch(TRANSCRIBE_URL, { method: "POST", body: form, signal });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 200);
      throw new Error(`HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
    }
    const data = (await response.json()) as { text?: string };
    if (state.session !== session) return;
    if (commitTranscript((data.text ?? "").trim()) === true) state.inserted += 1;
  } catch (error) {
    if (signal?.aborted || state.session !== session) return;
    showStatus(`Transcription failed: ${errorMessage(error)}`, true);
  }
}

async function stopListening() {
  const session = state.session;
  state.phase = "finishing";
  updateButton();
  endPhrase();
  teardownCapture();
  if (state.pending > 0) showStatus("Transcribing the last phrase...");

  await state.queue;
  if (state.session !== session) return;

  state.phase = "idle";
  state.abort = undefined;
  updateButton();
  showStatus(
    state.inserted > 0 ? "Voice input inserted. Review it, then send." : "No speech was recognized.",
  );
}

function teardownCapture() {
  const capture = state.capture;
  state.capture = undefined;
  if (!capture) return;
  capture.tap.port.onmessage = null;
  capture.source.disconnect();
  capture.tap.disconnect();
  capture.sink.disconnect();
  capture.stream.getTracks().forEach((track) => track.stop());
  void capture.context.close();
}

function showListening() {
  const waiting = state.pending > 0 ? ` Transcribing ${state.pending}...` : "";
  showStatus(`Listening. Pause to send a phrase, click the mic to stop.${waiting}`);
}

function encodeWav(samples: Float32Array, rate: number): Blob {
  // Downsample to TARGET_RATE by averaging, then write 16-bit mono PCM.
  const outRate = rate > TARGET_RATE ? TARGET_RATE : rate;
  const ratio = rate / outRate;
  const length = Math.floor(samples.length / ratio);
  const buffer = new ArrayBuffer(44 + length * 2);
  const view = new DataView(buffer);

  const writeText = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  writeText(0, "RIFF");
  view.setUint32(4, 36 + length * 2, true);
  writeText(8, "WAVE");
  writeText(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, outRate, true);
  view.setUint32(28, outRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeText(36, "data");
  view.setUint32(40, length * 2, true);

  for (let i = 0; i < length; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.max(start + 1, Math.min(samples.length, Math.floor((i + 1) * ratio)));
    let sum = 0;
    for (let j = start; j < end; j++) sum += samples[j];
    const value = Math.max(-1, Math.min(1, sum / (end - start)));
    view.setInt16(44 + i * 2, value < 0 ? value * 0x8000 : value * 0x7fff, true);
  }
  return new Blob([buffer], { type: "audio/wav" });
}

function sttModel(): string {
  try {
    return localStorage.getItem(MODEL_STORAGE_KEY) || DEFAULT_MODEL;
  } catch {
    return DEFAULT_MODEL;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

function commitTranscript(transcript: string): boolean | undefined {
  if (!transcript) return undefined;

  const editor = document.querySelector<HTMLElement>(
    '[data-component="prompt-input"][contenteditable="true"]',
  );
  if (!editor) {
    showStatus("Could not find the OpenCode prompt editor.", true);
    return false;
  }

  editor.focus();
  const existing = editor.textContent?.replace(/\u200B/g, "") ?? "";
  const separator =
    existing.trim().length > 0 && !existing.endsWith(" ") && !existing.endsWith("\n") ? " " : "";
  editor.textContent = `${existing}${separator}${transcript}`;
  editor.dispatchEvent(
    new InputEvent("input", { bubbles: true, inputType: "insertText", data: transcript }),
  );
  placeCursorAtEnd(editor);
  return true;
}

function placeCursorAtEnd(editor: HTMLElement) {
  const range = document.createRange();
  range.selectNodeContents(editor);
  range.collapse(false);

  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function updateButton() {
  if (!state.button) return;

  const listening = state.phase === "listening" || state.phase === "starting";
  const busy = state.phase === "finishing";
  state.button.classList.toggle("is-listening", listening);
  state.button.classList.toggle("is-busy", busy);
  state.button.disabled = busy;
  const label = busy ? "Transcribing" : listening ? "Stop voice input" : "Start voice input";
  state.button.setAttribute("aria-label", label);
  state.button.title = label;
  state.button.setAttribute("aria-pressed", String(listening));
}

function showStatus(message: string, error = false) {
  let status = document.querySelector<HTMLElement>("[data-opencode-voice-status]");
  if (!status) {
    status = document.createElement("div");
    status.dataset.opencodeVoiceStatus = "true";
    document.body.appendChild(status);
  }

  status.setAttribute("role", error ? "alert" : "status");
  status.textContent = message;
  status.className = error
    ? "opencode-web-voice-plugin-status is-error"
    : "opencode-web-voice-plugin-status";
  window.setTimeout(() => {
    if (status?.textContent === message && state.phase === "idle") status.remove();
  }, 4000);
}

function injectStyle() {
  state.style = document.createElement("style");
  state.style.textContent = `
    .opencode-web-voice-plugin-button {
      width: 32px;
      height: 32px;
      border: 0;
      border-radius: 8px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex: 0 0 auto;
      padding: 0;
      background: transparent;
      color: currentColor;
      cursor: pointer;
      opacity: 0.75;
    }
    .opencode-web-voice-plugin-button:hover,
    .opencode-web-voice-plugin-button:focus-visible {
      opacity: 1;
      background: color-mix(in srgb, currentColor 12%, transparent);
      outline: none;
    }
    .opencode-web-voice-plugin-button.is-listening {
      color: #ef4444;
      opacity: 1;
    }
    .opencode-web-voice-plugin-button.is-busy {
      opacity: 0.5;
      cursor: progress;
    }
    .opencode-web-voice-plugin-icon {
      width: 20px;
      height: 20px;
    }
    .opencode-web-voice-plugin-sr-only {
      position: absolute;
      width: 1px;
      height: 1px;
      margin: -1px;
      overflow: hidden;
      clip: rect(0, 0, 0, 0);
      white-space: nowrap;
      border: 0;
      padding: 0;
    }
    .opencode-web-voice-plugin-status {
      position: fixed;
      left: 50%;
      bottom: 20px;
      z-index: 2147483647;
      max-width: min(560px, calc(100vw - 32px));
      transform: translateX(-50%);
      border: 1px solid color-mix(in srgb, currentColor 16%, transparent);
      border-radius: 999px;
      padding: 8px 12px;
      background: color-mix(in srgb, canvas 92%, black 8%);
      color: canvastext;
      box-shadow: 0 10px 30px rgb(0 0 0 / 18%);
      font: 13px/1.35 system-ui, sans-serif;
    }
    .opencode-web-voice-plugin-status.is-error {
      color: #ef4444;
    }
  `;
  document.head.appendChild(state.style);
}

function cleanup() {
  state.session += 1;
  state.abort?.abort();
  teardownCapture();
  state.button?.remove();
  state.style?.remove();
  state.observer?.disconnect();
  document.querySelector("[data-opencode-voice-status]")?.remove();
  state.phase = "idle";
  state.detector = freshDetector();
  state.abort = undefined;
  voiceWindow[STATE_KEY] = undefined;
}

main();
