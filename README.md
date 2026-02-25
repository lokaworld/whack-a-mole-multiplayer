# 🔨 Whack-a-Mole — HTML5/WebGL Edition

A browser-based Whack-a-Mole game replicating the Unity version with **MediaPipe hand-tracking** support.

## 🎮 How to Play

1. **Open `index.html`** in any modern browser (Chrome/Edge recommended)
2. Click **START GAME** → Select **1 Player** → Click **CONTINUE**
3. **Whack moles** by clicking/tapping the holes!

### Controls
| Input | Action |
|---|---|
| 🖱️ Mouse click | Whack mole |
| 👆 Touch tap | Whack mole (mobile) |
| ✊ Fist gesture | Whack mole (MediaPipe — needs webcam) |

### Mole Types
| Mole | Points | Behavior |
|---|---|---|
| 🟤 Normal | +10 | One hit to kill |
| 🛡️ Helmet | +10 then +20 | Needs 2 hits (helmet cracks first) |
| 🔴 Danger | −1 Life | ⚠️ Warning appears first — DON'T hit it! |
| ❤️ Heart | +1 Life | Restores a lost heart (max 3) |

### Difficulty
- Every 15 seconds: moles spawn faster, more danger moles
- At 75 seconds: major difficulty spike
- Tutorial: first 10s = normal only, next 15s = normal + helmet, then all types

## 🖐 MediaPipe Hand Tracking

When you start the game, the browser will ask for **webcam access**. If granted:
- Your hand position is tracked via a yellow circle on screen
- Make a **fist** over a mole hole to whack it
- Webcam preview appears in the bottom-right corner

> **Note**: MediaPipe requires HTTPS or `localhost`. For local files, use Chrome with `--allow-file-access-from-files` flag, or serve via `npx serve .`

## 🚀 Quick Start with Local Server

```bash
npx serve .
```

Then open `http://localhost:3000` in your browser.

## 📁 Project Structure

```
WhackMoleWebGL_Replica/
├── index.html    ← Complete self-contained game
└── README.md     ← This file
```

No build tools, no dependencies, no installation required. Just open and play!
