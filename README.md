# YouTube Trimmer

A local web app for trimming YouTube videos and stitching multiple clips (from YouTube or uploaded files) into a single output video. Runs entirely on your machine — no cloud, no upload limits.

## Features

### Trim (`/trim`)
- Paste any YouTube URL to load the video with an embedded player
- Set start and end points using the interactive timeline or by typing timestamps
- Choose output format (MP4 or MP3) and resolution
- Download the trimmed clip via a direct server-streamed link

### Stitch (`/stitch`)
- Add clips from two sources: YouTube URL or local file upload
- Each clip has its own embedded player (YouTube iframe or HTML5 video)
- Per-clip trim controls in `HH:MM:SS` format — editable text fields that validate on blur and reset gracefully on bad input
- Reorder clips up/down
- Preview mode: plays all clips in order (respecting trim points) in the browser, no encoding required
- Stitch: encodes and concatenates all clips into a single MP4
- **Save/load project**: export your clip list + trim points to a JSON file and reload it later to resume work
- Clip list persists in `localStorage` across page refreshes

## How It Works

The frontend is a React + TypeScript SPA (Vite). The backend is Express + Socket.io. The frontend connects via a WebSocket to stream real-time progress logs from long-running `yt-dlp`/`ffmpeg` processes.

### Trim flow
1. Frontend calls `GET /api/info?url=...` → server runs `yt-dlp -j` to fetch metadata
2. User adjusts trim points using the timeline or YouTube player's current time
3. On "Download", a `start-download` socket event triggers `yt-dlp --download-sections *START-END --force-keyframes-at-cuts`
4. Progress lines are streamed back via `log` and `progress` socket events
5. On completion, `complete` fires with a download URL (`/downloads/clip_*.mp4`)

### Stitch flow
1. Files are uploaded one at a time via `POST /api/stitch/upload-file` (multipart)
2. YouTube clips are resolved via `GET /api/info` for duration/title
3. User clicks "Stitch N clips" → `POST /api/stitch/start` with the socket ID and full clip list
4. Server processes each clip in sequence:
   - **YouTube clips**: `yt-dlp --download-sections` to a temp file, then `ffmpeg` normalization pass
   - **File clips**: `ffmpeg` trim + normalization pass
5. Normalization re-encodes each clip to `1920×1080 h264 30fps AAC` and **resets timestamps to zero** (`setpts=PTS-STARTPTS` + `asetpts=PTS-STARTPTS`)
6. A final `ffmpeg -f concat -c copy` joins the normalized clips into the output file
7. Temp files and uploads are deleted; the output is served from `/downloads/`

#### Why the two-step normalization matters

`yt-dlp --download-sections` cuts the requested segment but preserves the **absolute timestamps** from the source video. A clip starting at 10:00 in the source has PTS ~600 s. When `ffmpeg -f concat` concatenates multiple such clips, its demuxer uses `start_time=0` from each file's container header while the actual stream packets carry the absolute timestamps — so the output ends up with huge timestamp gaps (e.g. a 5-minute frozen frame before the next clip plays at PTS 626 s).

The normalization step fixes this by re-encoding each clip through ffmpeg with `setpts=PTS-STARTPTS`, which shifts all presentation timestamps so the first frame is at exactly 0. It also scales every clip to the same resolution, which prevents ffmpeg's filter-graph reconfiguration between clips (a separate cause of dropped frames and frozen video when clips have different resolutions like 480p, 1080p, and 4K).

After normalization, all clips are `h264 1920×1080 30 fps / AAC 44100 Hz` with timestamps starting at 0, so stream-copy concat is both safe and fast.

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React 18, TypeScript, Vite |
| Routing | React Router v6 |
| Icons | Lucide React |
| Styling | Plain CSS (custom dark theme) |
| Backend | Node.js, Express, Socket.io |
| Video download | yt-dlp |
| Video processing | FFmpeg |
| IPC | WebSocket (Socket.io) for real-time log streaming |

## Prerequisites

- **Node.js** ≥ 18
- **yt-dlp** — `brew install yt-dlp` or `pip install yt-dlp`
- **FFmpeg** — `brew install ffmpeg`

## Setup

```bash
# Install all dependencies
npm run install:all

# Start both server (port 3001) and client dev server (port 5173)
npm run dev
```

Then open `http://localhost:5173`.

The client proxies all `/api`, `/socket.io`, and `/downloads` requests to the server, so everything works through a single origin during development.

## Project Structure

```
YouTubeTrimmer/
├── client/                  # React frontend (Vite)
│   └── src/
│       ├── App.tsx          # Nav + routing
│       ├── TrimPage.tsx     # Single-clip trim UI
│       ├── StitchPage.tsx   # Multi-clip stitch UI
│       └── App.css          # Global dark theme styles
├── server/
│   └── index.js             # Express + Socket.io server
├── downloads/               # Output clips (git-ignored)
├── uploads/                 # Temp upload staging (git-ignored)
└── package.json             # Root: concurrently dev script
```

## Notes

- Output files in `downloads/` are not automatically cleaned up between sessions — delete them manually when done.
- File clips uploaded for stitching are deleted from `uploads/` automatically after the stitch job completes (or fails).
- The stitch output is always re-encoded to 1920×1080 h264. Source 4K clips are downscaled; source clips narrower than 16:9 get black letterbox bars.
- The preview player in Stitch mode works entirely in-browser (no encoding) — it plays each clip using the YouTube IFrame API or an HTML5 `<video>` element and advances automatically at each clip's trim end point.
