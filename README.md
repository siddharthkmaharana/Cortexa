<div align="center">

```
 ██████╗ ██████╗ ██████╗ ████████╗███████╗██╗  ██╗ █████╗
██╔════╝██╔═══██╗██╔══██╗╚══██╔══╝██╔════╝╚██╗██╔╝██╔══██╗
██║     ██║   ██║██████╔╝   ██║   █████╗   ╚███╔╝ ███████║
██║     ██║   ██║██╔══██╗   ██║   ██╔══╝   ██╔██╗ ██╔══██║
╚██████╗╚██████╔╝██║  ██║   ██║   ███████╗██╔╝ ██╗██║  ██║
 ╚═════╝ ╚═════╝ ╚═╝  ╚═╝   ╚═╝   ╚══════╝╚═╝  ╚═╝╚═╝  ╚═╝
```

**Cognitive Oriented Real-Time Execution Assistant**

A desktop AI agent with live computer vision, conversational intelligence,
and full laptop automation — all in one split-panel interface.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Electron](https://img.shields.io/badge/Electron-28-47848F?logo=electron)](https://www.electronjs.org/)
[![React](https://img.shields.io/badge/React-18-61DAFB?logo=react)](https://react.dev/)
[![FastAPI](https://img.shields.io/badge/FastAPI-0.110-009688?logo=fastapi)](https://fastapi.tiangolo.com/)
[![Claude](https://img.shields.io/badge/Powered%20by-Claude%20claude--sonnet--4-CC785C)](https://anthropic.com)
[![Python](https://img.shields.io/badge/Python-3.11+-3776AB?logo=python)](https://python.org)

<br />

![CORTEXA Interface]("C:\Users\sidsm\PROJECTS\Cortexa.png")

</div>

---

## What is CORTEXA?

CORTEXA is a desktop application that splits your screen into two linked halves: a **live camera panel** on the left and an **AI chat agent** on the right. The camera feed is continuously analyzed by a vision model — detecting objects, reading text, scanning barcodes — and everything it sees is fed into the agent's context. You type, speak, or point your camera, and CORTEXA responds, explains, or acts.

When you say *"open VS Code and my last project"*, CORTEXA breaks that into steps and executes them. When you hold a product up to the camera, it identifies it and pulls specs, pricing, and reviews. When it notices you look stressed, it softens its tone. Everything runs on your machine — your data only leaves for API calls.

---

## Features

### Vision Layer
- **Live object detection** — Claude vision analyzes your camera feed every few seconds, drawing labeled bounding boxes with confidence scores directly on the video
- **Freeze frame** — Lock any frame for deep-dive analysis
- **Scene awareness** — Describes your full environment even without a specific object query
- **Barcode and QR scanning** — Point at any barcode or QR code for instant product lookup (ZXing.js, fully client-side)
- **Emotion detection** — Facial landmark analysis subtly adjusts the agent's tone in real time (face-api.js in a Web Worker)

### AI Agent Core
- **Unified context** — Camera feed, typed messages, and voice all feed the same agent simultaneously
- **Persistent memory** — Conversation history carries across the session; context never resets mid-conversation
- **Command vs. question routing** — The agent distinguishes questions (answered in chat) from commands (routed to the automation engine)
- **Product intelligence** — Show it a product and it fetches specs, pricing, and reviews automatically

### Voice Pipeline
- **Speech-to-text** — Web Speech API (built-in, zero latency) or OpenAI Whisper (local, higher accuracy)
- **Text-to-speech** — Browser `speechSynthesis` or ElevenLabs for premium voice quality
- **Wake word** — Say *"Hey CORTEXA"* to activate listening without touching the keyboard (Porcupine engine)

### Laptop Automation
- **App control** — Open, close, and switch between any application
- **System settings** — Toggle dark/light mode, adjust volume, control brightness, manage Wi-Fi and Bluetooth
- **Browser automation** — Playwright drives Chrome or Firefox for searches, form fills, and navigation
- **File management** — Create folders, rename files, move items — all via natural language
- **Multi-step tasks** — Complex commands are broken into ordered steps, executed in sequence, and confirmed in chat

---

## Architecture

```
┌───────────────────────────────────────────────────────────────┐
│                      Electron 28 (Chromium)                   │
│                                                               │
│  ┌────────────────────────┐   ┌─────────────────────────────┐ │
│  │      Vision Panel      │   │      Agent + Chat Panel     │ │
│  │                        │   │                             │ │
│  │  getUserMedia()        │   │  Claude API (chat+vision)   │ │
│  │  Canvas + Overlays     │   │  Conversation history       │ │
│  │  ZXing.js (barcode)    │   │  Command parser             │ │
│  │  face-api.js (mood)    │   │  Voice I/O                  │ │
│  └────────────────────────┘   └─────────────────────────────┘ │
│                                                               │
│              contextBridge / IPC  (preload.js)                │
└───────────────────────────┬───────────────────────────────────┘
                            │  HTTP  ·  localhost:8000
                            ▼
┌───────────────────────────────────────────────────────────────┐
│                 FastAPI Backend  (Python 3.11)                │
│                                                               │
│   POST /automate/app       →  subprocess / AppleScript        │
│   POST /automate/system    →  OS settings APIs               │
│   POST /automate/browser   →  Playwright                      │
│   POST /automate/files     →  os / shutil                     │
│   POST /voice/transcribe   →  Whisper (optional)              │
│   GET  /screenshot         →  pyautogui                       │
└───────────────────────────────────────────────────────────────┘
```

---

## Tech Stack

| Layer | Technology | Notes |
|---|---|---|
| Desktop shell | **Electron 28** | Full OS access via contextBridge |
| Frontend | **React 18 + Tailwind CSS** | Renderer process |
| Vision + Chat AI | **Claude claude-sonnet-4-20250514** | Anthropic API |
| STT (fast) | **Web Speech API** | Chromium built-in, zero setup |
| STT (accurate) | **OpenAI Whisper** | Runs locally via backend |
| TTS | **ElevenLabs / speechSynthesis** | Configurable |
| Wake word | **Porcupine (Picovoice)** | Free tier available |
| Barcode / QR | **ZXing.js** | Client-side, no server needed |
| Emotion detection | **face-api.js** | Runs in Web Worker |
| Backend | **Python 3.11 + FastAPI** | Local automation server |
| App control | **subprocess + AppleScript / PowerShell** | macOS and Windows |
| Browser automation | **Playwright** | Chromium, Firefox, WebKit |
| Bundler | **Webpack 5 (Electron Forge)** | Dev + production builds |
| Packaging | **PyInstaller** | Backend ships as single binary |

---

## Prerequisites

- **Node.js** 20+ and **npm** 9+
- **Python** 3.11+
- **Git**
- An **Anthropic API key** — get one at [console.anthropic.com](https://console.anthropic.com)

**macOS only:**
```bash
brew install brightness   # Display brightness control
```

**Windows only:** PowerShell 5.1+ is included in Windows 10/11. Optionally place `nircmd.exe` in `backend/bin/` for advanced system control.

---

## Installation

### 1. Clone the repository

```bash
git clone https://github.com/yourusername/cortexa.git
cd cortexa
```

### 2. Install frontend dependencies

```bash
npm install
```

### 3. Set up the Python backend

```bash
cd backend
python -m venv venv

# macOS / Linux
source venv/bin/activate

# Windows
venv\Scripts\activate

pip install -r requirements.txt
playwright install chromium
cd ..
```

### 4. Configure environment variables

```bash
cp .env.example .env
```

Open `.env` and fill in your keys:

```env
# Required
ANTHROPIC_API_KEY=sk-ant-...

# Optional — Voice
ELEVENLABS_API_KEY=
ELEVENLABS_VOICE_ID=
PICOVOICE_ACCESS_KEY=

# Optional — Backend
BACKEND_PORT=8000
BACKEND_SECRET=your-random-secret-token
```

> **Note:** After first launch, API keys are stored in the OS keychain via Electron's `safeStorage`. The `.env` file is only read on initial setup.

---

## Running in Development

Open two terminals:

**Terminal 1 — Backend:**
```bash
cd backend
source venv/bin/activate        # Windows: venv\Scripts\activate
uvicorn main:app --host 127.0.0.1 --port 8000 --reload
```

**Terminal 2 — Electron:**
```bash
npm run start
```

The Electron window opens automatically. Grant camera access when prompted.

---

## Building for Production

```bash
# 1. Package the backend as a standalone binary
cd backend
pyinstaller --onefile main.py -n cortexa-backend --distpath ../resources/bin
cd ..

# 2. Build and package the Electron app
npm run make
```

Output installers are written to `out/make/`:

| Platform | Output |
|---|---|
| macOS | `CORTEXA-x.x.x.dmg` |
| Windows | `CORTEXA-x.x.x Setup.exe` |
| Linux | `CORTEXA-x.x.x.AppImage` |

The PyInstaller binary is bundled inside `resources/bin/` and spawned automatically by `main.js` — end users do not need Python installed.

---

## Project Structure

```
cortexa/
│
├── src/
│   ├── main/
│   │   ├── index.js                # Electron main process, window creation
│   │   ├── preload.js              # contextBridge — secure IPC API surface
│   │   └── backend.js              # Spawns FastAPI process on app launch
│   │
│   └── renderer/
│       ├── App.jsx                 # Root layout, panel split
│       ├── config.js               # Runtime configuration
│       ├── components/
│       │   ├── CameraPanel.jsx     # Video element, canvas, overlay renderer
│       │   ├── DetectionOverlay.jsx  # Bounding box drawing logic
│       │   ├── ChatPanel.jsx       # Message list, input bar, quick chips
│       │   ├── StatusBar.jsx       # Top bar, status indicators, clock
│       │   └── VoiceButton.jsx     # Recording state, wake word UI
│       ├── hooks/
│       │   ├── useCamera.js        # getUserMedia, frame capture interval
│       │   ├── useVision.js        # Vision API polling, detection state
│       │   ├── useAgent.js         # Chat API calls, conversation history
│       │   └── useVoice.js         # STT, TTS, wake word integration
│       └── utils/
│           ├── claude.js           # Anthropic SDK wrapper
│           ├── automation.js       # FastAPI HTTP client
│           └── barcodeScanner.js   # ZXing.js wrapper
│
├── backend/
│   ├── main.py                     # FastAPI app entry point
│   ├── models.py                   # Pydantic request/response schemas
│   ├── routes/
│   │   ├── app_control.py          # Open, close, switch apps
│   │   ├── system.py               # Dark mode, volume, brightness, Wi-Fi
│   │   ├── browser.py              # Playwright automation
│   │   └── files.py                # File and folder management
│   └── requirements.txt
│
├── docs/
│   ├── screenshot.png
│   └── architecture.png
│
├── resources/
│   └── bin/                        # PyInstaller binary (generated at build time)
│
├── .env.example
├── package.json
├── webpack.main.config.js
├── webpack.renderer.config.js
└── README.md
```

---

## Usage Guide

### Basic conversation
Type any question in the chat input and press Enter or click Send. The agent always has the current camera scene in its context — no need to describe what you're looking at.

### Voice input
Click the microphone button or say *"Hey CORTEXA"* if the wake word is enabled. Speak your message — it transcribes and sends automatically.

### Freeze frame
Click the **pause icon** in the camera toolbar to lock the current frame. The agent will analyze the frozen image in detail rather than the live feed.

### Commands
Speak or type commands naturally. CORTEXA identifies them and routes to the automation backend:

| You say | What happens |
|---|---|
| `"Open Spotify"` | subprocess launches the app |
| `"Switch to dark mode"` | AppleScript / PowerShell toggles system appearance |
| `"Turn volume to 40"` | OS volume set to 40% |
| `"Search Google for this product"` | Playwright opens Chrome and searches |
| `"Create a folder called Projects on my Desktop"` | Folder created via os.makedirs |
| `"Open VS Code and load my last project"` | Two-step task executed in sequence |
| `"What is this?"` *(holding up product)* | Vision identifies it, agent fetches details |

### Barcode scanning
Point the camera at any barcode or QR code. Detection is instant and client-side — no server round-trip needed.

---

## Configuration

All runtime settings live in `src/renderer/config.js`:

```javascript
export const CONFIG = {
  // How often to send a frame to the vision API (ms)
  visionIntervalMs: 3000,

  // How many conversation turns to keep in memory
  maxHistoryTurns: 20,

  // JPEG quality for frames sent to the vision API (0.0–1.0)
  frameQuality: 0.75,

  // Voice
  voiceEnabled: true,
  ttsProvider: 'browser',        // 'browser' | 'elevenlabs'
  sttProvider: 'webSpeechApi',   // 'webSpeechApi' | 'whisper'
  wakeWordEnabled: false,

  // Emotion detection
  emotionDetectionEnabled: true,
  emotionIntervalMs: 5000,

  // Barcode scanning
  barcodeEnabled: true,
  barcodeIntervalMs: 500,
};
```

---

## Security

CORTEXA runs entirely locally. Here is exactly what leaves your machine:

| Data | Destination | Condition |
|---|---|---|
| Camera keyframes (JPEG) | Anthropic API | Every 3 s during vision polling |
| Chat messages | Anthropic API | On each send |
| Audio — Web Speech API | Browser STT engine | Real-time when voice is active |
| Audio — Whisper | Stays local | Never sent externally |

**Local backend hardening:**
- FastAPI binds strictly to `127.0.0.1` — unreachable from the network
- Every request requires a session token generated fresh on each app launch
- Allowed applications are whitelisted; arbitrary binary execution is rejected
- All file paths are sanitized against directory traversal attacks
- API keys are stored in the OS keychain via `safeStorage` — never in plain text after first launch

---

## Roadmap

- [ ] Multi-monitor support — choose which display to analyze
- [ ] Screen capture mode — use a screen recording instead of (or alongside) the camera
- [ ] Plugin system — community-built automation modules
- [ ] Local LLM fallback — Ollama integration for fully offline operation
- [ ] Mobile companion — iOS / Android app as a remote camera source
- [ ] Conversation export — save sessions as Markdown or PDF
- [ ] Custom wake words — train your own trigger phrase

---

## Contributing

Contributions are welcome. Please open an issue before submitting a pull request for significant changes.

```bash
# Fork the repo, then:
git checkout -b feature/your-feature-name
# Make your changes
git commit -m "feat: describe your change"
git push origin feature/your-feature-name
# Open a pull request
```

Follow the existing code style and include tests for any new automation routes.

---

## License

MIT — see [LICENSE](LICENSE) for details.

---

<div align="center">

Built with Claude · Electron · React · FastAPI

*CORTEXA — see everything, do anything.*

</div>
