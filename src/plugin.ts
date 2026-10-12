// Voice input for OpenCode Web through Lens.
// Records audio in the browser and sends it to an OpenAI-compatible
// transcription endpoint through Lens (POST /__lens/stt), instead of the
// browser's Web Speech API. Audio never leaves your own machines.

const STATE_KEY = "__opencodeWebVoicePlugin";
const TRANSCRIBE_URL = "/__lens/stt";
const DEFAULT_MODEL = "mlx-community/whisper-large-v3-turbo";
// Override the model per browser with:
// localStorage.setItem("opencode-voice-stt-model", "<model name>")
const MODEL_STORAGE_KEY = "opencode-voice-stt-model";
const MIME_CANDIDATES = ["audio/webm;codecs=opus", "audio/mp4", "audio/ogg;codecs=opus"];

type VoiceWindow = Window & {
  [STATE_KEY]?: { cleanup: () => void };
};

const voiceWindow = window as VoiceWindow;

type Phase = "idle" | "starting" | "recording" | "transcribing";

type State = {
  phase: Phase;
  chunks: Blob[];
  recorder?: MediaRecorder;
  stream?: MediaStream;
  abort?: AbortController;
  button?: HTMLButtonElement;
  style?: HTMLStyleElement;
  observer?: MutationObserver;
};

const state: State = {
  phase: "idle",
  chunks: [],
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
  if (state.phase === "recording") {
    state.recorder?.stop();
    return;
  }
  if (state.phase !== "idle") return;

  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
    showStatus(
      "Microphone recording is not available here. Open OpenCode Web over HTTPS or localhost.",
      true,
    );
    return;
  }

  state.phase = "starting";
  updateButton();

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (error) {
    state.phase = "idle";
    updateButton();
    showStatus(`Microphone access failed: ${errorMessage(error)}`, true);
    return;
  }

  let recorder: MediaRecorder;
  try {
    const mimeType = MIME_CANDIDATES.find((type) => MediaRecorder.isTypeSupported(type));
    recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  } catch (error) {
    stream.getTracks().forEach((track) => track.stop());
    state.phase = "idle";
    updateButton();
    showStatus(`Recording could not start: ${errorMessage(error)}`, true);
    return;
  }

  state.stream = stream;
  state.recorder = recorder;
  state.chunks = [];
  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) state.chunks.push(event.data);
  };
  recorder.onstop = () => {
    void finishRecording(recorder);
  };
  recorder.start();

  state.phase = "recording";
  updateButton();
  showStatus("Recording. Click the mic again to stop.");
}

async function finishRecording(recorder: MediaRecorder) {
  if (state.recorder !== recorder) return;

  stopStream();
  const type = recorder.mimeType || state.chunks[0]?.type || "audio/webm";
  const blob = new Blob(state.chunks, { type });
  state.chunks = [];
  state.recorder = undefined;

  if (blob.size === 0) {
    state.phase = "idle";
    updateButton();
    showStatus("No audio was recorded.", true);
    return;
  }

  state.phase = "transcribing";
  updateButton();
  showStatus("Transcribing...");

  const form = new FormData();
  form.append("file", blob, `voice.${extensionFor(type)}`);
  form.append("model", sttModel());
  form.append("response_format", "json");

  const abort = new AbortController();
  state.abort = abort;
  try {
    const response = await fetch(TRANSCRIBE_URL, {
      method: "POST",
      body: form,
      signal: abort.signal,
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 200);
      throw new Error(`HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
    }
    const data = (await response.json()) as { text?: string };
    const committed = commitTranscript((data.text ?? "").trim());
    if (committed === true) {
      showStatus("Voice input inserted. Review it, then send.");
    } else if (committed === undefined) {
      showStatus("No speech was recognized.");
    }
  } catch (error) {
    if (abort.signal.aborted) return;
    showStatus(`Transcription failed: ${errorMessage(error)}`, true);
  } finally {
    if (state.abort === abort) {
      state.abort = undefined;
      state.phase = "idle";
      updateButton();
    }
  }
}

function sttModel(): string {
  try {
    return localStorage.getItem(MODEL_STORAGE_KEY) || DEFAULT_MODEL;
  } catch {
    return DEFAULT_MODEL;
  }
}

function extensionFor(type: string): string {
  if (type.includes("mp4")) return "m4a";
  if (type.includes("ogg")) return "ogg";
  return "webm";
}

function stopStream() {
  state.stream?.getTracks().forEach((track) => track.stop());
  state.stream = undefined;
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

  const recording = state.phase === "recording" || state.phase === "starting";
  const busy = state.phase === "transcribing";
  state.button.classList.toggle("is-listening", recording);
  state.button.classList.toggle("is-busy", busy);
  state.button.disabled = busy;
  const label = busy ? "Transcribing" : recording ? "Stop voice input" : "Start voice input";
  state.button.setAttribute("aria-label", label);
  state.button.title = label;
  state.button.setAttribute("aria-pressed", String(recording));
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
  if (state.recorder) {
    state.recorder.ondataavailable = null;
    state.recorder.onstop = null;
    if (state.recorder.state !== "inactive") state.recorder.stop();
  }
  stopStream();
  state.abort?.abort();
  state.button?.remove();
  state.style?.remove();
  state.observer?.disconnect();
  document.querySelector("[data-opencode-voice-status]")?.remove();
  state.phase = "idle";
  state.chunks = [];
  state.recorder = undefined;
  state.abort = undefined;
  voiceWindow[STATE_KEY] = undefined;
}

main();
