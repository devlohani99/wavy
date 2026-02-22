# Wavy

Wavy is a realtime collaboration playground that bundles a multiplayer whiteboard, competitive typing rooms, and low-latency voice chat into one seamless experience. The project is split into a Node/Express backend and a Vite/React frontend connected through Socket.IO and WebRTC.

## Features

- **Canvas mode** – spin up an 8-character room ID and sketch together with live ink, shapes, and canvas-wide events.
- **Typing mode** – race on the same prompt with score-based leaderboards (per-character grading, completion tracking, and basic anti-cheat flags) plus per-user countdown timers.
- **Voice chat** – opt-in peer-to-peer audio that works in both modes via WebRTC signaling over Socket.IO.
- **Room lifecycle** – REST endpoints to create/fetch rooms, socket events for join/leave, and automatic cleanup when the last participant disconnects.
- **UI niceties** – name modal with persistence, copy/paste guards for typing rooms, toast feedback, and responsive layouts built with Tailwind.

## Tech Stack

| Layer      | Details |
|------------|---------|
| Frontend   | React 19, Vite, React Router, Tailwind CSS 4, Socket.IO Client |
| Backend    | Node.js, Express 5, Socket.IO, MongoDB (Mongoose) |
| Realtime   | Socket.IO channels for drawing/typing events, WebRTC for audio |
| Tooling    | Nodemon (backend dev), ESLint, Vite dev server |

## Project Structure

```
.
├── backend/           # Express + Socket.IO server
│   ├── server.js
│   ├── routes/
│   ├── models/
│   ├── store/
│   └── package.json
├── frontend/          # Vite/React client
│   ├── src/
│   ├── public/
│   └── package.json
└── README.md
```

## Prerequisites

- Node.js 18+
- npm 9+
- MongoDB instance (local or cloud)

## Environment Variables

### Backend (`backend/.env`)

| Variable    | Description |
|-------------|-------------|
| `PORT`      | Port for the Express server (default `5000`). |
| `CLIENT_URL`| Comma-separated list of allowed origins for CORS (e.g., `http://localhost:5173`). |
| `MONGO_URI` | MongoDB connection string. |

### Frontend (`frontend/.env`)

| Variable           | Description |
|--------------------|-------------|
| `VITE_BACKEND_URL` | Base URL for API and Socket.IO calls (e.g., `http://localhost:5000`). |

## Getting Started

1. **Install dependencies**
   ```bash
   cd backend
   npm install
   cd ../frontend
   npm install
   ```

2. **Run the backend**
   ```bash
   cd backend
   npm run dev   # uses nodemon
   ```

3. **Run the frontend**
   ```bash
   cd frontend
   npm run dev
   ```

4. Open the Vite dev server URL (typically `http://localhost:5173`).

## Available Scripts

### Backend

- `npm run dev` – start the Express server with nodemon.
- `npm start` – start the server without hot reload.

### Frontend

- `npm run dev` – launch Vite with React Fast Refresh.
- `npm run build` – create a production build in `dist/`.
- `npm run preview` – serve the production build locally.
- `npm run lint` – run ESLint across the React codebase.





