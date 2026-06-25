# OpenCode Web Voice Plugin

Voice input for OpenCode Web, installed through Lens.

This plugin adds a microphone button to the OpenCode Web prompt composer and inserts Web Speech API transcripts into the prompt editor.

## Install

Install Lens first:

```bash
git clone git@github.com:Flickwire-Agent/opencode-lens.git
cd opencode-lens
pnpm install
```

Install and build this plugin:

```bash
git clone git@github.com:Flickwire-Agent/opencode-web-voice-plugin.git
cd opencode-web-voice-plugin
pnpm install
pnpm build
```

Start OpenCode Web:

```bash
opencode web
```

Start Lens with the voice plugin:

```bash
cd ../opencode-lens
OPENCODE_TARGET="http://127.0.0.1:5050" OPENCODE_WEB_PLUGINS="../opencode-web-voice-plugin/lens.plugin.json" pnpm proxy
```

Open `http://127.0.0.1:3000`. The `Mic` button appears in the prompt composer.

## Usage

1. Click `Mic`.
2. Approve the browser microphone permission.
3. Speak your prompt.
4. Click the button again to stop and insert the transcript.
5. Review and send the prompt normally.

Speech recognition uses the browser Web Speech API. It works best in Chrome or Edge on `localhost` or HTTPS.

## Checks

```bash
pnpm typecheck
pnpm lint
pnpm format:check
pnpm build
```
