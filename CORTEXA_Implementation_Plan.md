# CORTEXA — Implementation Plan
**Cognitive Oriented Real-Time Execution Assistant**
Version 1.0 · May 2026

---

## Overview

CORTEXA is a desktop AI agent combining live computer vision, an LLM-powered chat agent, and local laptop automation into a single split-panel interface. This document outlines the complete build roadmap across four phases, from a working prototype to a fully featured production release.

---

## Architecture Summary

```
┌─────────────────────────────────────────────────────────┐
│                    Electron Shell (React)                │
│  ┌──────────────────────┐  ┌──────────────────────────┐ │
│  │   Vision Panel       │  │    Agent + Chat Panel    │ │
│  │  getUserMedia()      │  │  Claude API (vision+chat)│ │
│  │  Canvas + Overlay    │  │  Conversation memory     │ │
│  │  ZXing.js (barcode)  │  │  Voice I/O (Whisper/TTS) │ │
│  │  face-api.js (mood)  │  │  Command parser          │ │
│  └──────────────────────┘  └──────────────────────────┘ │
│                    IPC Bridge (contextBridge)            │
└─────────────────────────────────────────────────────────┘
                            │
                            ▼ HTTP (localhost:8000)
┌─────────────────────────────────────────────────────────┐
│              FastAPI Backend (Python)                    │
│  /automate   /screenshot   /system   /browser           │
│  subprocess · AppleScript/PowerShell · Playwright       │
└─────────────────────────────────────────────────────────┘
```

---

## Phase 1 — Core Shell + Real Camera

**Goal:** Working Electron app with a live camera feed, real bounding-box overlays from Claude vision, and a functional chat panel.

**Timeline:** 2–3 weeks

### 1.1 Electron Setup

```bash
npm create electron-app@latest cortexa -- --template=webpack
cd cortexa && npm install react react-dom tailwindcss
```

Key `main.js` permissions required:

```javascript
webPreferences: {
  nodeIntegration: false,
  contextIsolation: true,
  preload: path.join(__dirname, 'preload.js')
}
```

Add `"media"` to `session.defaultSession.setPermissionRequestHandler` so the renderer can access the camera.

### 1.2 Real Camera Feed

In the React renderer, open the camera stream and draw frames to a canvas:

```javascript
const stream = await navigator.mediaDevices.getUserMedia({
  video: { width: 1280, height: 720, facingMode: 'user' }
});
videoRef.current.srcObject = stream;
```

Every 3 seconds, snapshot the canvas as a base64 JPEG and send to Claude's vision API.

### 1.3 Claude Vision Integration

Send keyframes to `claude-sonnet-4-20250514` with a structured prompt:

```javascript
{
  model: "claude-sonnet-4-20250514",
  max_tokens: 800,
  messages: [{
    role: "user",
    content: [
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: frameBase64 }},
      { type: "text", text: "Detect all objects. Return JSON: { objects: [{ label, confidence, bbox: {x,y,w,h} (normalized 0-1) }], scene_description: string }" }
    ]
  }]
}
```

Parse the JSON response and draw L-bracket overlays on the canvas using the normalized bounding box coordinates.

### 1.4 Chat Agent with Scene Context

Each chat message includes a system prompt that injects the latest vision output:

```javascript
const systemPrompt = `You are CORTEXA. Current camera scene: ${sceneDescription}. 
Detected objects: ${detectedObjects.map(o => o.label).join(', ')}.
Maintain conversation history. For commands, describe automation steps you will execute.`;
```

Maintain `conversationHistory` as a rolling array (last 20 turns) to give the agent persistent memory.

**Deliverables:**
- Electron app boots and shows split panel
- Camera feed is live with real detection overlays
- Chat agent responds with scene awareness

---

## Phase 2 — Local Automation Backend

**Goal:** A Python FastAPI server that receives structured commands from the Electron frontend and executes them on the OS.

**Timeline:** 2 weeks

### 2.1 FastAPI Server Setup

```bash
pip install fastapi uvicorn pyautogui playwright psutil
uvicorn main:app --host 127.0.0.1 --port 8000
```

The Electron `main.js` spawns this server on launch:

```javascript
const backend = spawn('uvicorn', ['main:app', '--port', '8000']);
app.on('quit', () => backend.kill());
```

### 2.2 Automation Endpoints

**App control** (`POST /automate/app`):

```python
@app.post("/automate/app")
async def control_app(cmd: AppCommand):
    if cmd.action == "open":
        # macOS
        subprocess.Popen(["open", "-a", cmd.target])
        # Windows: subprocess.Popen(["start", cmd.target], shell=True)
    elif cmd.action == "close":
        subprocess.run(["pkill", "-x", cmd.target])
    return {"status": "executed", "action": cmd.action, "target": cmd.target}
```

**System settings** (`POST /automate/system`):

```python
@app.post("/automate/system")
async def system_setting(cmd: SystemCommand):
    if cmd.setting == "dark_mode":
        subprocess.run(["osascript", "-e",
          'tell application "System Events" to tell appearance preferences to set dark mode to true'])
    elif cmd.setting == "volume":
        subprocess.run(["osascript", "-e", f"set volume output volume {cmd.value}"])
    elif cmd.setting == "brightness":
        # Uses `brightness` CLI tool (brew install brightness)
        subprocess.run(["brightness", str(cmd.value / 100)])
```

**Browser automation** (`POST /automate/browser`):

```python
from playwright.async_api import async_playwright

@app.post("/automate/browser")
async def browser_action(cmd: BrowserCommand):
    async with async_playwright() as p:
        browser = await p.chromium.connect_over_cdp("http://localhost:9222")
        page = browser.contexts[0].pages[0]
        if cmd.action == "navigate":
            await page.goto(cmd.url)
        elif cmd.action == "search":
            await page.goto(f"https://www.google.com/search?q={cmd.query}")
```

**File management** (`POST /automate/files`):

```python
@app.post("/automate/files")
async def file_action(cmd: FileCommand):
    if cmd.action == "create_folder":
        os.makedirs(os.path.expanduser(cmd.path), exist_ok=True)
    elif cmd.action == "rename":
        os.rename(os.path.expanduser(cmd.src), os.path.expanduser(cmd.dst))
    elif cmd.action == "move":
        shutil.move(os.path.expanduser(cmd.src), os.path.expanduser(cmd.dst))
```

### 2.3 Agent Command Routing

In the chat agent's system prompt, define the command schema. When the agent detects a command intent, it returns structured JSON alongside its response:

```javascript
// In React, parse agent output for embedded command blocks
const commandMatch = reply.match(/```command\n([\s\S]+?)\n```/);
if (commandMatch) {
  const command = JSON.parse(commandMatch[1]);
  await fetch('http://localhost:8000/automate/' + command.type, {
    method: 'POST',
    body: JSON.stringify(command)
  });
}
```

**Deliverables:**
- "Open VS Code" → app launches within 2 seconds
- "Switch to dark mode" → OS dark mode activates
- "Search Google for X" → Chrome navigates automatically
- All actions confirmed back in chat

---

## Phase 3 — Voice Pipeline

**Goal:** Full voice I/O. Speak to CORTEXA, hear responses. Wake word support.

**Timeline:** 1–2 weeks

### 3.1 Speech-to-Text (Two Options)

**Option A — Web Speech API (fast start, Chromium-native):**

```javascript
const recognition = new webkitSpeechRecognition();
recognition.continuous = false;
recognition.interimResults = true;
recognition.lang = 'en-US';
recognition.onresult = (e) => {
  const transcript = e.results[0][0].transcript;
  setInputText(transcript);
  if (e.results[0].isFinal) sendMessage(transcript);
};
```

**Option B — OpenAI Whisper (higher accuracy, runs locally):**

```python
# Backend endpoint
import whisper
model = whisper.load_model("base")

@app.post("/voice/transcribe")
async def transcribe(audio: UploadFile):
    with tempfile.NamedTemporaryFile(suffix=".wav") as f:
        f.write(await audio.read())
        result = model.transcribe(f.name)
    return {"text": result["text"]}
```

The frontend records via `MediaRecorder`, sends the blob to `/voice/transcribe`, then injects the transcript into the chat input.

### 3.2 Text-to-Speech

**Browser-native (instant):**

```javascript
const speak = (text) => {
  const utt = new SpeechSynthesisUtterance(text);
  utt.voice = speechSynthesis.getVoices().find(v => v.name.includes('Google'));
  utt.rate = 1.05; utt.pitch = 0.95;
  speechSynthesis.speak(utt);
};
```

**ElevenLabs (premium quality):**

```javascript
const audio = await fetch('https://api.elevenlabs.io/v1/text-to-speech/{voice_id}', {
  method: 'POST',
  headers: { 'xi-api-key': ELEVEN_KEY },
  body: JSON.stringify({ text, model_id: 'eleven_monolingual_v1' })
});
new Audio(URL.createObjectURL(await audio.blob())).play();
```

### 3.3 Wake Word ("Hey CORTEXA")

Use the `porcupine` wake word engine (free tier available):

```javascript
const porcupine = await PorcupineWeb.create(ACCESS_KEY, [{ publicPath: '/hey-cortexa.ppn' }], {});
porcupine.onmessage = (event) => {
  if (event.data.isFinished && event.data.keywordIndex !== -1) {
    startListening(); // Activate microphone
  }
};
```

**Deliverables:**
- Voice input toggles with mic button or wake word
- Transcribed text appears in input field before sending
- Agent responses optionally read aloud
- Wake word works hands-free in background

---

## Phase 4 — Advanced Vision Features

**Goal:** Barcode scanning, QR codes, emotion/mood detection, and scene-aware smart suggestions.

**Timeline:** 1–2 weeks

### 4.1 Barcode & QR Code Scanning

ZXing.js runs entirely client-side against the video stream canvas:

```javascript
import { BrowserMultiFormatReader } from '@zxing/library';

const reader = new BrowserMultiFormatReader();
// Run against the camera canvas every 500ms
setInterval(async () => {
  try {
    const result = await reader.decodeFromCanvas(canvasRef.current);
    if (result) handleBarcode(result.getText());
  } catch {}
}, 500);

const handleBarcode = (code) => {
  // Auto-inject barcode value into agent context
  sendMessage(`I'm pointing my camera at a barcode: ${code}. Look this up on Amazon and Google Shopping.`);
};
```

### 4.2 Emotion & Mood Detection

`face-api.js` runs in a Web Worker to avoid blocking the UI thread:

```javascript
// worker.js
import * as faceapi from 'face-api.js';
await faceapi.loadFaceExpressionModel('/models');

self.onmessage = async ({ data: imageData }) => {
  const detections = await faceapi.detectSingleFace(imageData).withFaceExpressions();
  if (detections) self.postMessage(detections.expressions);
};
```

The dominant expression is passed to the agent's system prompt to subtly adjust tone:

```javascript
const moodHint = getMoodHint(expressions); // e.g. "user appears stressed"
systemPrompt += ` Adapt your tone: ${moodHint}.`;
```

### 4.3 Scene Awareness Mode

When no specific object is queried, CORTEXA describes the full environment and offers proactive suggestions. Add a "scene mode" toggle that sends the current frame with:

```
"Describe everything you see in this scene. What is the person likely doing? 
Suggest 2-3 relevant things I could help with based on the context."
```

**Deliverables:**
- Barcode → instant product lookup in chat
- QR codes → URL opened in browser automatically
- Mood-adaptive agent tone
- Proactive context-aware suggestions

---

## Tech Stack Summary

| Layer | Technology | Purpose |
|-------|-----------|---------|
| Desktop shell | Electron 28 | OS access, window management |
| Frontend | React 18 + Tailwind | UI rendering |
| Vision API | Claude claude-sonnet-4-20250514 | Object detection, scene analysis |
| Chat API | Claude claude-sonnet-4-20250514 | Conversational AI agent |
| Voice STT | Web Speech API / Whisper | Speech transcription |
| Voice TTS | speechSynthesis / ElevenLabs | Audio responses |
| Wake word | Porcupine (Picovoice) | Hands-free activation |
| Barcode | ZXing.js | Client-side scanning |
| Emotion | face-api.js | Facial expression detection |
| Backend | Python 3.11 + FastAPI | Automation execution |
| App control | subprocess + AppleScript/PowerShell | Open/close apps |
| Browser | Playwright | Web automation |
| Bundler | Webpack 5 (Electron Forge) | Build pipeline |

---

## File Structure

```
cortexa/
├── src/
│   ├── main/
│   │   ├── index.js          # Electron main process
│   │   ├── preload.js        # contextBridge API
│   │   └── backend.js        # FastAPI process spawner
│   └── renderer/
│       ├── App.jsx           # Root component, layout
│       ├── components/
│       │   ├── CameraPanel.jsx    # Video, canvas, overlays
│       │   ├── DetectionOverlay.jsx # Bounding boxes
│       │   ├── ChatPanel.jsx      # Messages, input
│       │   ├── StatusBar.jsx      # Top bar + indicators
│       │   └── VoiceButton.jsx    # Recording UI
│       ├── hooks/
│       │   ├── useCamera.js       # getUserMedia, frame capture
│       │   ├── useVision.js       # Vision API calls, polling
│       │   ├── useAgent.js        # Chat API, history
│       │   └── useVoice.js        # STT/TTS/wake word
│       └── utils/
│           ├── claude.js          # Anthropic SDK wrapper
│           ├── automation.js      # FastAPI client
│           └── barcodeScanner.js  # ZXing wrapper
└── backend/
    ├── main.py               # FastAPI app
    ├── routes/
    │   ├── app_control.py    # Open/close apps
    │   ├── system.py         # Dark mode, volume, etc.
    │   ├── browser.py        # Playwright automation
    │   └── files.py          # File management
    ├── models.py             # Pydantic schemas
    └── requirements.txt
```

---

## Security Considerations

The local FastAPI server must be locked down before any release:

- Bind strictly to `127.0.0.1` — never `0.0.0.0`
- Add a randomly generated session token on app start, required on every request
- Whitelist allowed applications (reject arbitrary binary execution)
- Sanitize all file paths to prevent directory traversal
- Store API keys in Electron's `safeStorage` (OS keychain backed), never in `.env` files

---

## Build & Release

```bash
# Development
npm run start           # Launches Electron + Webpack dev server
uvicorn backend.main:app --reload --port 8000

# Production build
npm run make            # Packages Electron app
# Backend bundled via PyInstaller into a single binary:
pyinstaller --onefile backend/main.py -n cortexa-backend
```

The PyInstaller binary is placed inside the Electron `resources/` folder and spawned by `main.js` on startup — no separate Python install required for end users.

---

## Milestones

| Phase | Feature | Estimate |
|-------|---------|----------|
| Phase 1 | Electron + Camera + Vision + Chat | 2–3 weeks |
| Phase 2 | FastAPI Backend + Automation | 2 weeks |
| Phase 3 | Voice Pipeline + Wake Word | 1–2 weeks |
| Phase 4 | Barcode + Emotion + Scene AI | 1–2 weeks |
| **Total** | **Full CORTEXA v1** | **~8 weeks** |

---

*CORTEXA Implementation Plan · Generated May 2026*
