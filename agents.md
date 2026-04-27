# Agent Runbook

Repository: `YouTubeTailor`

This file is the operational source of truth for agents working in this repo.

## What this repo is

- Local web app for trimming YouTube videos and stitching clips together.
- Frontend: React + TypeScript + Vite in `client/`.
- Backend: Express + Socket.io in `server/`.
- Root scripts coordinate both halves for development.

## Prerequisites

- Node.js 18 or newer
- `yt-dlp` installed and available on `PATH`
- `ffmpeg` installed and available on `PATH`

## Install

From the repo root:

```bash
npm run install:all
```

This installs dependencies in both `server/` and `client/`.

## Start the app

Preferred dev startup from the repo root:

```bash
npm run dev
```

This starts:

- Backend on `http://0.0.0.0:3001`
- Vite frontend on `http://localhost:5173`

The client proxies `/api`, `/socket.io`, and `/downloads` to the backend during development.

## Restart when the server dies

If the frontend, backend, or combined dev session is killed, restart from the repo root:

```bash
npm run restart:dev
```

If you only need the backend, run:

```bash
npm run restart:server
```

If you need the full frontend/backend dev session without restarting, run:

```bash
npm run dev
```

If port `3001` is already occupied, identify the listener first:

```bash
lsof -iTCP:3001 -sTCP:LISTEN -n -P
```

## Important files

- `package.json` - root orchestration scripts
- `server/index.js` - API, WebSocket, and download/stitch logic
- `client/src/App.tsx` - routing
- `client/src/TrimPage.tsx` - trim UI
- `client/src/StitchPage.tsx` - stitch UI
- `README.md` - product and setup overview

## Ports

- Backend: `3001`
- Frontend: `5173`

## Runtime notes

- Outputs are written to `downloads/`.
- Temporary uploads and stitch intermediates are written to `uploads/`.
- `combined.log` captures output from the root `npm run dev` script.
- The backend defaults to `PORT=3001`, but it honors an explicit `PORT` environment variable.

## Working rules

- Do not revert user changes unless explicitly asked.
- Prefer small, direct edits.
- Use existing scripts before adding new orchestration.
- Keep documentation aligned with the actual scripts in `package.json`.
- After any frontend, backend, or shared code change, restart the dev session so both `3001` and `5173` match the current workspace.
- Prefer `npm run restart:dev` for a one-command full-stack restart when either listener may be stale.
