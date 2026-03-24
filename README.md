# Wavy

Wavy is a real-time collaborative workspace that lets users draw together on a shared canvas and compete in multiplayer typing sprints -- all from the browser. Rooms are created instantly, shared via an 8-character code, and feature built-in WebRTC voice chat so participants can talk while they collaborate.

---

## Table of Contents

- [Features](#features)
- [Tech Stack](#tech-stack)
- [Project Structure](#project-structure)
- [Prerequisites](#prerequisites)
- [Getting Started](#getting-started)
- [Environment Variables](#environment-variables)
- [API Endpoints](#api-endpoints)
- [WebSocket Events](#websocket-events)
- [Architecture Overview](#architecture-overview)
- [Deployment](#deployment)
- [License](#license)

---

## Features

### Canvas Mode
- Create or join collaborative drawing rooms with an 8-character room code.
- Tools: pencil, eraser, rectangle, square, circle, triangle, and directional arrows.
- Customizable brush size and color (preset palette + custom color picker).
- One-click canvas clearing broadcast to all participants.
- Real-time drawing sync via WebSockets.
- Peer-to-peer voice chat using WebRTC (STUN-only, no TURN).
- Mute/unmute toggle and connection status indicator.

### Typing Sprint Mode
- Create typing rooms with a randomly selected passage.
- 60-second time limit per round.
- Live leaderboard ranked by accuracy score and completion time.
- Real-time WPM (words per minute) tracking.
- Anti-cheat system: paste detection, speed anomaly flagging.
- Copy/paste blocked on the input field.
- Persistent username stored in localStorage.
- WebRTC voice chat with speaking-indicator visualization.
- Toast notifications for user events (finished, timed out, etc.).

### General
- Shareable room links with one-click copy to clipboard.
- Error boundary and backend health gate on the frontend.
- Responsive UI styled with Tailwind CSS v4.

---

## Tech Stack

| Layer     | Technology                                                    |
|-----------|---------------------------------------------------------------|
| Frontend  | React 19, React Router 7, Vite 7, Tailwind CSS 4             |
| Backend   | Node.js, Express 5, Socket.IO 4                               |
| Database  | MongoDB (via Mongoose 9)                                       |
| Real-time | Socket.IO (WebSocket transport), WebRTC (voice chat)           |
| HTTP      | Axios                                                          |

---

## Project Structure

```
wavy/
  backend/
    models/
      Room.js               # Mongoose schema for canvas rooms
    routes/
      roomRoutes.js          # REST endpoints for canvas room CRUD
      typingRoutes.js        # REST endpoints for typing room creation and lookup
    store/
      typingRooms.js         # In-memory store for active typing rooms
    utils/
      computeScore.js        # Scoring algorithm for typing accuracy
      generateRoomId.js      # Random 8-character room ID generator
    server.js                # Express + Socket.IO server entry point
    package.json

  frontend/
    public/
    src/
      components/
        AppErrorBoundary.jsx   # Global error boundary
        BackendHealthGate.jsx  # Blocks UI until backend is reachable
        Canvas.jsx             # HTML5 canvas drawing component
      hooks/
        useBackendHealth.js    # Polling hook for backend /health endpoint
      lib/
        apiClient.js           # Axios instance with base URL config
      pages/
        Home.jsx               # Landing page with mode selector
        Room.jsx               # Canvas collaboration room
        TypingRoom.jsx         # Multiplayer typing sprint room
      App.jsx                  # Route definitions
      main.jsx                 # React DOM entry point
      index.css                # Global styles
    index.html
    vite.config.js
    vercel.json                # Vercel SPA rewrite rules
    package.json
```

---

## Prerequisites

- **Node.js** v18 or later
- **npm** v9 or later
- **MongoDB** instance (local or hosted, e.g. MongoDB Atlas)

---

## Getting Started

### 1. Clone the repository

```bash
git clone https://github.com/devlohani99/wavy.git
cd wavy
```

### 2. Install dependencies

```bash
# Backend
cd backend
npm install

# Frontend
cd ../frontend
npm install
```

### 3. Configure environment variables

Create a `.env` file in both `backend/` and `frontend/` directories (see section below).

### 4. Start the development servers

```bash
# Terminal 1 -- Backend
cd backend
npm run dev          # uses nodemon, restarts on file changes

# Terminal 2 -- Frontend
cd frontend
npm run dev          # Vite dev server on http://localhost:5173
```

Open `http://localhost:5173` in your browser.

---

## Environment Variables

### backend/.env

| Variable     | Description                                      | Default                            |
|--------------|--------------------------------------------------|------------------------------------|
| `PORT`       | Port the Express server listens on               | `5000`                             |
| `CLIENT_URL` | Comma-separated allowed origins for CORS         | `http://localhost:5173`            |
| `MONGO_URI`  | MongoDB connection string                        | `mongodb://localhost:27017/wavy`   |

### frontend/.env

| Variable            | Description                          | Default                    |
|---------------------|--------------------------------------|----------------------------|
| `VITE_BACKEND_URL`  | Backend server URL for API and WS    | `http://localhost:5000`    |

---

## API Endpoints

### Canvas Rooms

| Method | Path                   | Description                        |
|--------|------------------------|------------------------------------|
| POST   | `/api/rooms/create`    | Create a new canvas room           |
| GET    | `/api/rooms/:roomId`   | Get room details by room ID        |

### Typing Rooms

| Method | Path                          | Description                            |
|--------|-------------------------------|----------------------------------------|
| POST   | `/api/typing/create-room`     | Create a new typing room with a random passage |
| GET    | `/api/typing/:roomId`         | Get typing room details and text       |

### Health Check

| Method | Path       | Description              |
|--------|------------|--------------------------|
| GET    | `/health`  | Returns `{ status: "ok" }` |

---

## WebSocket Events

### Canvas Room Events

| Event              | Direction        | Description                                        |
|--------------------|------------------|----------------------------------------------------|
| `join-room`        | Client to Server | Join a canvas room by room ID                      |
| `leave-room`       | Client to Server | Leave the current canvas room                      |
| `draw`             | Bidirectional    | Freehand drawing data                              |
| `shape-draw`       | Bidirectional    | Shape drawing data (rectangle, circle, etc.)       |
| `arrow-draw`       | Bidirectional    | Arrow drawing data                                 |
| `clear-canvas`     | Bidirectional    | Clear the entire canvas                            |
| `existing-users`   | Server to Client | List of socket IDs already in the room             |
| `user-joined`      | Server to Client | A new user joined the room                         |
| `user-left`        | Server to Client | A user left the room                               |
| `user-count-update` | Server to Client | Updated user count                                |
| `offer`            | Bidirectional    | WebRTC offer for voice peer connection              |
| `answer`           | Bidirectional    | WebRTC answer for voice peer connection             |
| `ice-candidate`    | Bidirectional    | ICE candidate exchange for voice                    |

### Typing Room Events

| Event                  | Direction        | Description                                    |
|------------------------|------------------|------------------------------------------------|
| `join-typing-room`     | Client to Server | Join a typing room with username               |
| `leave-typing-room`    | Client to Server | Leave the typing room                          |
| `typing-update`        | Client to Server | Send current typed text for scoring            |
| `typing-users-update`  | Server to Client | Updated participant count                      |
| `leaderboard-update`   | Server to Client | Full leaderboard with scores and flags         |
| `user-finished`        | Server to Client | A user completed the passage                   |
| `typing-timeup`        | Server to Client | Time expired for the current user              |
| `user-timeup`          | Server to Client | Another user ran out of time                   |
| `typing-room-ready`    | Server to Client | New round/passage is ready                     |
| `join-voice`           | Client to Server | Join voice chat in the typing room             |
| `leave-voice`          | Client to Server | Leave voice chat                               |
| `typing-voice-offer`   | Bidirectional    | WebRTC offer for typing room voice              |
| `typing-voice-answer`  | Bidirectional    | WebRTC answer for typing room voice             |
| `typing-voice-ice`     | Bidirectional    | ICE candidate for typing room voice             |
| `voice-participants`   | Server to Client | List of current voice participants              |
| `voice-user-joined`    | Server to Client | A new voice participant joined                  |
| `voice-user-left`      | Server to Client | A voice participant left                        |

---

## Architecture Overview

```
Browser (React + Vite)
  |
  |-- REST (Axios) --> Express API --> MongoDB (room persistence)
  |
  |-- WebSocket (Socket.IO) --> Express Server (event routing)
  |
  |-- WebRTC (peer-to-peer) --> Other Browsers (voice audio)
```

- **Canvas rooms** are persisted in MongoDB. When all users disconnect, the room document is deleted.
- **Typing rooms** are stored in-memory on the server (not persisted). They are cleaned up when the last user leaves.
- **Voice chat** uses peer-to-peer WebRTC connections. The server only handles signaling (offer/answer/ICE exchange). Audio streams flow directly between browsers.
- **Anti-cheat** in typing mode flags users for paste events, suspiciously fast input rates, and large text deltas. Flagged users are visible on the leaderboard.
- **Scoring** is character-level: +1 for each correct character, -1 for each incorrect character, -1 for extra characters beyond the expected word length.

---

## Deployment

### Frontend (Vercel)

The frontend includes a `vercel.json` with SPA rewrites. Deploy by connecting the `frontend/` directory to a Vercel project. Set the `VITE_BACKEND_URL` environment variable to the deployed backend URL.

### Backend

Deploy the backend to any Node.js hosting provider (Render, Railway, Fly.io, etc.). Ensure the following:

1. Set all environment variables (`PORT`, `MONGO_URI`, `CLIENT_URL`).
2. `CLIENT_URL` must include the deployed frontend origin for CORS.
3. The hosting provider must support WebSocket connections for Socket.IO.

---

## License

This project does not currently specify a license. Contact the author for usage terms.

---

**Author:** [devlohani99](https://github.com/devlohani99) | [LinkedIn](https://www.linkedin.com/in/devlohani/)
