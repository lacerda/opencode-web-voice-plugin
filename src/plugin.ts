type SpeechRecognitionEventLike = Event & {
  results: SpeechRecognitionResultList;
  resultIndex: number;
};

type SpeechRecognitionErrorEventLike = Event & {
  error?: string;
  message?: string;
};

type SpeechRecognitionLike = EventTarget & {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  start: () => void;
  stop: () => void;
};

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

const STATE_KEY = "__opencodeWebVoicePlugin";

type VoiceWindow = Window & {
  SpeechRecognition?: SpeechRecognitionConstructor;
  webkitSpeechRecognition?: SpeechRecognitionConstructor;
  [STATE_KEY]?: { cleanup: () => void };
};

const voiceWindow = window as VoiceWindow;

type State = {
  active: boolean;
  starting: boolean;
  hadError: boolean;
  finalText: string;
  interimText: string;
  recognition?: SpeechRecognitionLike;
  button?: HTMLButtonElement;
  style?: HTMLStyleElement;
  observer?: MutationObserver;
};

const state: State = {
  active: false,
  starting: false,
  hadError: false,
  finalText: "",
  interimText: "",
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
  button.addEventListener("click", toggleRecognition);

  if (actions) {
    actions.insertBefore(button, actions.firstChild);
  } else {
    form.appendChild(button);
  }

  state.button = button;
  updateButton();
}

function toggleRecognition() {
  if (state.active || state.starting) {
    state.recognition?.stop();
    return;
  }

  const Recognition = voiceWindow.SpeechRecognition ?? voiceWindow.webkitSpeechRecognition;
  if (!Recognition) {
    showStatus(
      "Speech recognition is not available in this browser. Try Chrome or Edge over localhost/HTTPS.",
      true,
    );
    return;
  }

  state.finalText = "";
  state.interimText = "";
  state.hadError = false;
  state.starting = true;
  const recognition = new Recognition();
  state.recognition = recognition;
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = document.documentElement.lang || navigator.language || "en-US";
  recognition.onstart = () => {
    if (state.recognition !== recognition) return;

    state.starting = false;
    state.active = true;
    updateButton();
    showStatus("Listening. Click Mic again to stop.");
  };
  recognition.onend = () => {
    if (state.recognition !== recognition) return;

    state.starting = false;
    state.active = false;
    state.recognition = undefined;
    updateButton();
    if (!state.hadError) {
      commitTranscript();
      showStatus(state.finalText.trim() ? "Voice input inserted." : "Voice input stopped.");
    }
  };
  recognition.onerror = (event) => {
    if (state.recognition !== recognition) return;

    state.starting = false;
    state.active = false;
    state.hadError = true;
    updateButton();
    showStatus(
      `Voice input failed${event.error ? `: ${event.error}` : ""}${event.message ? ` (${event.message})` : ""}`,
      true,
    );
  };
  recognition.onresult = (event) => {
    if (state.recognition !== recognition) return;

    const results = Array.from(event.results);
    const final = results
      .filter((result) => result.isFinal)
      .map((result) => result[0]?.transcript ?? "")
      .join("");
    const interim = results
      .filter((result) => !result.isFinal)
      .map((result) => result[0]?.transcript ?? "")
      .join("");

    state.finalText = final;
    state.interimText = interim;
    showStatus((state.finalText + state.interimText).trim() || "Listening...");
  };

  updateButton();
  recognition.start();
}

function commitTranscript() {
  const transcript = state.finalText.trim();
  if (!transcript) return;

  const editor = document.querySelector<HTMLElement>(
    '[data-component="prompt-input"][contenteditable="true"]',
  );
  if (!editor) {
    showStatus("Could not find the OpenCode prompt editor.", true);
    return;
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

  const recording = state.active || state.starting;
  state.button.classList.toggle("is-listening", recording);
  state.button.setAttribute("aria-label", recording ? "Stop voice input" : "Start voice input");
  state.button.setAttribute("aria-pressed", String(recording));
}

function showStatus(message: string, error = false) {
  let status = document.querySelector<HTMLElement>("[data-opencode-voice-status]");
  if (!status) {
    status = document.createElement("div");
    status.dataset.opencodeVoiceStatus = "true";
    status.setAttribute("role", "status");
    document.body.appendChild(status);
  }

  status.textContent = message;
  status.className = error
    ? "opencode-web-voice-plugin-status is-error"
    : "opencode-web-voice-plugin-status";
  window.setTimeout(() => {
    if (status?.textContent === message && !state.active) status.remove();
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
  if (state.recognition) {
    state.recognition.onstart = null;
    state.recognition.onend = null;
    state.recognition.onerror = null;
    state.recognition.onresult = null;
    state.recognition.stop();
  }
  state.button?.remove();
  state.style?.remove();
  state.observer?.disconnect();
  document.querySelector("[data-opencode-voice-status]")?.remove();
  state.active = false;
  state.starting = false;
  state.recognition = undefined;
  voiceWindow[STATE_KEY] = undefined;
}

main();
