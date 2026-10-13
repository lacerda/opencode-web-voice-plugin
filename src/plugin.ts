// Voice input for OpenCode Web through Lens.
// Streams microphone audio over a WebSocket to a WhisperLiveKit server through
// Lens (/__lens/asr) and writes the transcript into the prompt while you talk.
// Audio never leaves your own machines.

const STATE_KEY = "__opencodeWebVoicePlugin";
const ASR_PATH = "/__lens/asr";
const TARGET_RATE = 16_000; // raw audio is sent as 16 kHz, 16-bit, mono
const SEND_INTERVAL_MS = 100; // raw audio is sent in chunks of this length
const RECORDER_TIMESLICE_MS = 250; // WebM chunk length if the server asks for WebM
const CONFIG_TIMEOUT_MS = 15_000; // first connection may wait for the model to load
const STOP_TIMEOUT_MS = 30_000;
// Prompt boxes in older and newer OpenCode Web versions.
const COMPOSER_SELECTOR = [
  '[data-component="prompt-input-v2"]',
  'form[data-component="composer"]',
  '[data-component="session-composer"]',
  '[data-component="session-new-composer"]',
  '[data-component="session-prompt-dock"]',
].join(", ");
const EDITOR_SELECTOR = [
  '[data-component="composer-editor"][contenteditable="true"]',
  '[data-component="prompt-input"][contenteditable="true"]',
].join(", ");
const LOG = (...args: unknown[]) => console.info("[voice]", ...args);
// The chosen microphone is saved per browser under this key.
const DEVICE_STORAGE_KEY = "opencode-voice-input-device";

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
type AudioMode = "pending" | "pcm" | "webm";

type Capture = {
  context: AudioContext;
  stream: MediaStream;
  source: MediaStreamAudioSourceNode;
  tap: AudioWorkletNode;
  sink: GainNode;
  rate: number;
};

type TranscriptLine = { speaker?: number; text?: string };
type ServerMessage = {
  type?: string;
  useAudioWorklet?: boolean;
  lines?: TranscriptLine[];
  buffer_transcription?: string;
  error?: string;
};

type State = {
  phase: Phase;
  session: number;
  mode: AudioMode;
  socket?: WebSocket;
  capture?: Capture;
  recorder?: MediaRecorder;
  pending: Float32Array[];
  pendingSamples: number;
  baseText: string;
  transcript: string;
  lastWritten: string;
  stopTimer?: number;
  configTimer?: number;
  finishStop?: () => void;
  buttons: Set<HTMLButtonElement>;
  pickers: Set<HTMLButtonElement>;
  menu?: HTMLElement;
  composer?: HTMLElement;
  messages: number;
  style?: HTMLStyleElement;
  observer?: MutationObserver;
};

const state: State = {
  phase: "idle",
  session: 0,
  mode: "pending",
  pending: [],
  pendingSamples: 0,
  baseText: "",
  transcript: "",
  lastWritten: "",
  buttons: new Set(),
  pickers: new Set(),
  messages: 0,
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
  for (const button of Array.from(state.buttons)) {
    if (!button.isConnected) state.buttons.delete(button);
  }
  for (const picker of Array.from(state.pickers)) {
    if (!picker.isConnected) state.pickers.delete(picker);
  }
  for (const composer of Array.from(document.querySelectorAll<HTMLElement>(COMPOSER_SELECTOR))) {
    if (composer.querySelector("[data-opencode-voice-input]")) continue;
    // Nested matches (a dock that contains a composer) get one button only.
    if (composer.parentElement?.closest(COMPOSER_SELECTOR)?.querySelector("[data-opencode-voice-input]")) {
      continue;
    }

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
    button.addEventListener("click", () => void toggleRecording(button));

    const actions =
      composer.querySelector<HTMLElement>('[data-slot="composer-actions"]') ??
      composer.querySelector<HTMLElement>('[data-action="prompt-attach"]')?.parentElement;
    const picker = document.createElement("button");
    picker.type = "button";
    picker.dataset.opencodeVoiceDevice = "true";
    picker.className = "opencode-web-voice-plugin-device";
    picker.title = "Choose microphone";
    picker.setAttribute("aria-label", "Choose microphone");
    picker.setAttribute("aria-haspopup", "menu");
    picker.innerHTML = `<svg aria-hidden="true" viewBox="0 0 10 10" fill="none"><path d="M2 3.5 5 6.5 8 3.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    picker.addEventListener("click", (event) => {
      event.stopPropagation();
      void openDeviceMenu(picker);
    });

    if (actions) {
      actions.insertBefore(picker, actions.firstChild);
      actions.insertBefore(button, picker);
    } else {
      composer.appendChild(button);
      composer.appendChild(picker);
    }
    state.buttons.add(button);
    state.pickers.add(picker);
  }
  updateButton();
}

async function toggleRecording(button: HTMLButtonElement) {
  if (state.phase === "listening") {
    await stopListening();
    return;
  }
  if (state.phase !== "idle") return;

  if (
    !navigator.mediaDevices?.getUserMedia ||
    typeof AudioContext === "undefined" ||
    typeof AudioWorkletNode === "undefined" ||
    typeof WebSocket === "undefined"
  ) {
    showStatus(
      "Microphone capture is not available here. Open OpenCode Web over HTTPS or localhost.",
      true,
    );
    return;
  }

  state.composer = button.closest<HTMLElement>(COMPOSER_SELECTOR) ?? undefined;
  const editor = findEditor();
  if (!editor) {
    showStatus("Could not find the OpenCode prompt editor.", true);
    return;
  }
  editor.focus({ preventScroll: true });

  state.phase = "starting";
  state.session += 1;
  const session = state.session;
  state.mode = "pending";
  state.pending = [];
  state.pendingSamples = 0;
  state.transcript = "";
  state.baseText = editor.textContent?.replace(/\u200B/g, "") ?? "";
  state.lastWritten = state.baseText;
  updateButton();
  showStatus("Connecting...");

  // Start the microphone first: Safari only allows it during the click itself.
  try {
    state.capture = await startCapture(session);
  } catch (error) {
    resetSession();
    showStatus(`Microphone access failed: ${errorMessage(error)}`, true);
    return;
  }
  if (state.session !== session) return;

  openSocket(session);
}

function openSocket(session: number) {
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  const socket = new WebSocket(`${scheme}://${location.host}${ASR_PATH}`);
  socket.binaryType = "arraybuffer";
  state.socket = socket;
  state.messages = 0;
  socket.onopen = () => LOG("connected");

  state.configTimer = window.setTimeout(() => {
    if (state.session !== session || state.mode !== "pending") return;
    resetSession();
    showStatus("The transcription server did not answer in time.", true);
  }, CONFIG_TIMEOUT_MS);

  socket.onmessage = (event) => {
    if (state.session !== session || typeof event.data !== "string") return;
    let data: ServerMessage;
    try {
      data = JSON.parse(event.data) as ServerMessage;
    } catch {
      return;
    }
    onServerMessage(data, session);
  };

  socket.onclose = (event) => {
    LOG("closed", { code: event.code, reason: event.reason, messages: state.messages, phase: state.phase });
    if (state.session !== session) return;
    if (state.phase === "finishing") {
      state.finishStop?.();
      return;
    }
    if (state.phase !== "idle") {
      resetSession();
      showStatus("The transcription connection closed unexpectedly.", true);
    }
  };

  socket.onerror = () => {
    // onclose follows and reports the problem.
  };
}

function onServerMessage(data: ServerMessage, session: number) {
  state.messages += 1;
  if (state.phase === "listening" && boxChanged()) {
    restartTranscription(session);
    return;
  }
  if (data.type || state.messages % 20 === 1) {
    LOG("message", state.messages, data.type ?? "transcript", (data.buffer_transcription ?? "").slice(-40));
  }
  if (data.type === "config") {
    window.clearTimeout(state.configTimer);
    state.mode = data.useAudioWorklet ? "pcm" : "webm";
    LOG("audio mode", state.mode);
    if (state.mode === "webm") {
      if (state.recorder && state.recorder.state !== "inactive") state.recorder.stop();
      state.recorder = undefined;
      startRecorder(session);
    }
    else flushPcm(true);
    state.phase = "listening";
    updateButton();
    showStatus("Listening. Click the mic to stop.");
    return;
  }

  if (data.type === "ready_to_stop") {
    state.finishStop?.();
    return;
  }

  if (data.error) {
    showStatus(`Transcription error: ${data.error}`, true);
    return;
  }

  if (Array.isArray(data.lines) || typeof data.buffer_transcription === "string") {
    const finished = (data.lines ?? [])
      .filter((line) => line.speaker !== -2)
      .map((line) => (line.text ?? "").trim())
      .filter(Boolean);
    const partial = (data.buffer_transcription ?? "").trim();
    const transcript = [...finished, partial].filter(Boolean).join(" ");
    if (transcript !== state.transcript) {
      state.transcript = transcript;
      writeTranscript();
    }
  }
}

async function startCapture(session: number): Promise<Capture> {
  const stream = await openMicrophone();
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
      if (state.session === session) onSamples(event.data);
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

async function openMicrophone(): Promise<MediaStream> {
  const base = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
  const saved = savedDevice();
  if (saved) {
    try {
      return await navigator.mediaDevices.getUserMedia({
        audio: { ...base, deviceId: { exact: saved } },
      });
    } catch (error) {
      const name = error instanceof DOMException ? error.name : "";
      if (name !== "OverconstrainedError" && name !== "NotFoundError") throw error;
      saveDevice("");
      showStatus("The chosen microphone is not available. Using the default.");
    }
  }
  return navigator.mediaDevices.getUserMedia({ audio: base });
}

function savedDevice(): string {
  try {
    return localStorage.getItem(DEVICE_STORAGE_KEY) || "";
  } catch {
    return "";
  }
}

function saveDevice(id: string) {
  try {
    if (id) localStorage.setItem(DEVICE_STORAGE_KEY, id);
    else localStorage.removeItem(DEVICE_STORAGE_KEY);
  } catch {
    // Storage can be unavailable (private mode); the choice then lasts until reload.
  }
}

async function listMicrophones(): Promise<MediaDeviceInfo[]> {
  let devices = (await navigator.mediaDevices.enumerateDevices()).filter(
    (device) => device.kind === "audioinput",
  );
  // Browsers hide device names until the page has had microphone access once.
  if (devices.length > 0 && devices.every((device) => !device.label)) {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((track) => track.stop());
    devices = (await navigator.mediaDevices.enumerateDevices()).filter(
      (device) => device.kind === "audioinput",
    );
  }
  return devices.filter((device) => device.deviceId && device.deviceId !== "default");
}

function closeDeviceMenu() {
  state.menu?.remove();
  state.menu = undefined;
  document.removeEventListener("click", closeDeviceMenu);
  document.removeEventListener("keydown", onMenuKey);
}

function onMenuKey(event: KeyboardEvent) {
  if (event.key === "Escape") closeDeviceMenu();
}

async function openDeviceMenu(anchor: HTMLElement) {
  if (state.menu) {
    closeDeviceMenu();
    return;
  }
  if (!navigator.mediaDevices?.enumerateDevices) {
    showStatus("This browser cannot list microphones.", true);
    return;
  }

  let devices: MediaDeviceInfo[];
  try {
    devices = await listMicrophones();
  } catch (error) {
    showStatus(`Could not list microphones: ${errorMessage(error)}`, true);
    return;
  }

  const current = savedDevice();
  const menu = document.createElement("div");
  menu.className = "opencode-web-voice-plugin-menu";
  menu.setAttribute("role", "menu");
  const options: Array<{ id: string; label: string }> = [
    { id: "", label: "System default" },
    ...devices.map((device, index) => ({
      id: device.deviceId,
      label: device.label || `Microphone ${index + 1}`,
    })),
  ];
  for (const option of options) {
    const item = document.createElement("button");
    item.type = "button";
    item.setAttribute("role", "menuitemradio");
    item.setAttribute("aria-checked", String(option.id === current));
    item.className = "opencode-web-voice-plugin-menu-item";
    item.textContent = `${option.id === current ? "✓ " : ""}${option.label}`;
    item.addEventListener("click", (event) => {
      event.stopPropagation();
      saveDevice(option.id);
      closeDeviceMenu();
      const later = state.phase === "idle" ? "" : " It applies from the next recording.";
      showStatus(`Microphone: ${option.label}.${later}`);
    });
    menu.appendChild(item);
  }

  document.body.appendChild(menu);
  const box = anchor.getBoundingClientRect();
  const height = menu.offsetHeight;
  const top = box.top - height - 6 >= 8 ? box.top - height - 6 : box.bottom + 6;
  menu.style.top = `${Math.max(8, top)}px`;
  menu.style.left = `${Math.max(8, Math.min(box.left, window.innerWidth - menu.offsetWidth - 8))}px`;
  state.menu = menu;
  window.setTimeout(() => {
    document.addEventListener("click", closeDeviceMenu);
    document.addEventListener("keydown", onMenuKey);
  }, 0);
}

function onSamples(samples: Float32Array) {
  if (state.mode === "webm") return;
  state.pending.push(samples);
  state.pendingSamples += samples.length;
  if (state.mode === "pcm") flushPcm(false);
}

function flushPcm(force: boolean) {
  const capture = state.capture;
  const socket = state.socket;
  if (!capture || !socket || socket.readyState !== WebSocket.OPEN) return;
  if (!force && state.pendingSamples < (SEND_INTERVAL_MS / 1000) * capture.rate) return;
  if (state.pendingSamples === 0) return;

  const input = new Float32Array(state.pendingSamples);
  let offset = 0;
  for (const chunk of state.pending) {
    input.set(chunk, offset);
    offset += chunk.length;
  }

  const ratio = capture.rate > TARGET_RATE ? capture.rate / TARGET_RATE : 1;
  const outLength = Math.floor(input.length / ratio);
  const used = Math.floor(outLength * ratio);
  const output = new DataView(new ArrayBuffer(outLength * 2));
  for (let i = 0; i < outLength; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.max(start + 1, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end; j++) sum += input[j];
    const value = Math.max(-1, Math.min(1, sum / (end - start)));
    output.setInt16(i * 2, value < 0 ? value * 0x8000 : value * 0x7fff, true);
  }

  // Keep the samples that did not fill a whole output sample for next time.
  const rest = input.subarray(used);
  state.pending = rest.length > 0 ? [rest.slice()] : [];
  state.pendingSamples = rest.length;
  if (outLength > 0) socket.send(output.buffer);
}

function startRecorder(session: number) {
  const capture = state.capture;
  if (!capture) return;
  state.pending = [];
  state.pendingSamples = 0;
  const mimeType = MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : undefined;
  const recorder = new MediaRecorder(capture.stream, mimeType ? { mimeType } : undefined);
  recorder.ondataavailable = (event) => {
    const socket = state.socket;
    if (state.session !== session || event.data.size === 0) return;
    if (socket && socket.readyState === WebSocket.OPEN) socket.send(event.data);
  };
  recorder.start(RECORDER_TIMESLICE_MS);
  state.recorder = recorder;
}

async function stopListening() {
  const session = state.session;
  state.phase = "finishing";
  updateButton();
  showStatus("Finishing the last words...");

  // Send what is still buffered, then the empty message that means "done".
  if (state.mode === "pcm") flushPcm(true);
  await stopRecorder();
  stopCapture();

  const socket = state.socket;
  if (socket && socket.readyState === WebSocket.OPEN) {
    await new Promise<void>((resolve) => {
      state.finishStop = resolve;
      state.stopTimer = window.setTimeout(resolve, STOP_TIMEOUT_MS);
      socket.send(new ArrayBuffer(0));
    });
  }
  if (state.session !== session) return;

  resetSession();
  showStatus(
    state.transcript ? "Voice input inserted. Review it, then send." : "No speech was recognized.",
  );
}

function stopRecorder(): Promise<void> {
  const recorder = state.recorder;
  state.recorder = undefined;
  if (!recorder || recorder.state === "inactive") return Promise.resolve();
  return new Promise((resolve) => {
    recorder.addEventListener("stop", () => resolve(), { once: true });
    recorder.stop();
  });
}

function stopCapture() {
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

function resetSession() {
  window.clearTimeout(state.configTimer);
  window.clearTimeout(state.stopTimer);
  state.finishStop = undefined;
  if (state.recorder && state.recorder.state !== "inactive") state.recorder.stop();
  state.recorder = undefined;
  stopCapture();
  const socket = state.socket;
  state.socket = undefined;
  if (socket) {
    socket.onmessage = null;
    socket.onclose = null;
    socket.onerror = null;
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      socket.close();
    }
  }
  state.pending = [];
  state.pendingSamples = 0;
  state.mode = "pending";
  state.phase = "idle";
  updateButton();
}

function findEditor(): HTMLElement | null {
  const composer = state.composer;
  if (composer?.isConnected) {
    const own = composer.querySelector<HTMLElement>(EDITOR_SELECTOR);
    if (own) return own;
  }
  const editors = Array.from(document.querySelectorAll<HTMLElement>(EDITOR_SELECTOR));
  return editors.find((editor) => editor.offsetParent !== null) ?? editors[0] ?? null;
}

function editorText(editor: HTMLElement): string {
  return editor.textContent?.replace(/\u200B/g, "") ?? "";
}

// True when the prompt box no longer holds what the plugin last wrote,
// because the message was sent, or the box was cleared or edited.
function boxChanged(): boolean {
  const editor = findEditor();
  if (!editor) return false;
  return editorText(editor) !== state.lastWritten;
}

// Start a new transcription session that continues from the box as it is now.
// The microphone keeps running; audio captured meanwhile is sent once the new
// connection is ready, so no speech is lost.
function restartTranscription(session: number) {
  const editor = findEditor();
  const current = editor ? editorText(editor) : "";
  state.baseText = current;
  state.lastWritten = current;
  if (!state.transcript) return; // nothing dictated yet: just follow the edit

  LOG("box changed, starting a new transcription session");
  state.transcript = "";
  window.clearTimeout(state.configTimer);
  if (state.recorder && state.recorder.state !== "inactive") state.recorder.stop();
  state.recorder = undefined;
  state.mode = "pending";

  const old = state.socket;
  state.socket = undefined;
  let opened = false;
  const openNext = () => {
    if (opened || state.session !== session || state.phase !== "listening") return;
    opened = true;
    openSocket(session);
  };
  if (old && (old.readyState === WebSocket.OPEN || old.readyState === WebSocket.CONNECTING)) {
    old.onmessage = null;
    old.onerror = null;
    // Let the server close the old session first; it handles one at a time.
    old.onclose = openNext;
    old.close();
    window.setTimeout(openNext, 1000);
  } else {
    openNext();
  }
}

function writeTranscript() {
  const editor = findEditor();
  if (!editor) return;
  const base = state.baseText;
  const separator =
    base.trim().length > 0 && !base.endsWith(" ") && !base.endsWith("\n") && state.transcript
      ? " "
      : "";
  const text = `${base}${separator}${state.transcript}`;
  if (document.activeElement !== editor) editor.focus({ preventScroll: true });
  editor.textContent = text;
  editor.dispatchEvent(
    new InputEvent("input", { bubbles: true, inputType: "insertText", data: state.transcript }),
  );
  placeCursorAtEnd(editor);
  state.lastWritten = editorText(editor);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
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
  const listening = state.phase === "listening" || state.phase === "starting";
  const busy = state.phase === "finishing";
  const label = busy ? "Finishing" : listening ? "Stop voice input" : "Start voice input";
  for (const button of state.buttons) {
    button.classList.toggle("is-listening", listening);
    button.classList.toggle("is-busy", busy);
    button.disabled = busy;
    button.setAttribute("aria-label", label);
    button.title = label;
    button.setAttribute("aria-pressed", String(listening));
  }
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
    .opencode-web-voice-plugin-device {
      width: 16px;
      height: 32px;
      margin-left: -4px;
      border: 0;
      border-radius: 6px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex: 0 0 auto;
      padding: 0;
      background: transparent;
      color: currentColor;
      cursor: pointer;
      opacity: 0.55;
    }
    .opencode-web-voice-plugin-device svg {
      width: 10px;
      height: 10px;
    }
    .opencode-web-voice-plugin-device:hover,
    .opencode-web-voice-plugin-device:focus-visible {
      opacity: 1;
      background: color-mix(in srgb, currentColor 12%, transparent);
      outline: none;
    }
    .opencode-web-voice-plugin-menu {
      position: fixed;
      z-index: 2147483647;
      min-width: 220px;
      max-width: min(360px, calc(100vw - 16px));
      padding: 4px;
      border: 1px solid color-mix(in srgb, canvastext 16%, transparent);
      border-radius: 10px;
      background: canvas;
      color: canvastext;
      box-shadow: 0 10px 30px rgb(0 0 0 / 22%);
      font: 13px/1.35 system-ui, sans-serif;
    }
    .opencode-web-voice-plugin-menu-item {
      display: block;
      width: 100%;
      padding: 7px 10px;
      border: 0;
      border-radius: 6px;
      background: transparent;
      color: inherit;
      font: inherit;
      text-align: left;
      cursor: pointer;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .opencode-web-voice-plugin-menu-item:hover,
    .opencode-web-voice-plugin-menu-item:focus-visible {
      background: color-mix(in srgb, canvastext 10%, transparent);
      outline: none;
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
  resetSession();
  state.buttons.forEach((button) => button.remove());
  state.buttons.clear();
  state.pickers.forEach((picker) => picker.remove());
  state.pickers.clear();
  closeDeviceMenu();
  state.style?.remove();
  state.observer?.disconnect();
  document.querySelector("[data-opencode-voice-status]")?.remove();
  voiceWindow[STATE_KEY] = undefined;
}

main();
