import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import apiClient from '../lib/apiClient.js';

const RoomIdInputMask = /^[A-Z0-9]{0,8}$/;

const modeConfigs = {
  canvas: {
    id: 'canvas',
    label: 'Canvas',
    title: 'Sketchboard rooms',
    description: 'Open a collaborative whiteboard with live ink, sticky ideas, and voice chat hooks.',
    createLabel: 'Create drawing room',
    joinLabel: 'Join drawing room',
    createStatus: 'Spinning up a fresh board...',
    joinStatus: 'Connecting you to the canvas...',
    endpoint: '/api/rooms/create',
    routePrefix: '/room/',
    accent: 'bg-blue-600',
  },
  typing: {
    id: 'typing',
    label: 'Typing',
    title: 'Typing sprint rooms',
    description: 'Race on the same passage, track WPM, and prep for voice-ready study jams.',
    createLabel: 'Create typing room',
    joinLabel: 'Join typing room',
    createStatus: 'Generating a new passage...',
    joinStatus: 'Loading the typing sprint...',
    endpoint: '/api/typing/create-room',
    routePrefix: '/typing/',
    accent: 'bg-indigo-600',
  },
};

const Home = () => {
  const [roomIdInput, setRoomIdInput] = useState('');
  const [statusMessage, setStatusMessage] = useState('');
  const [error, setError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [activeMode, setActiveMode] = useState('canvas');
  const navigate = useNavigate();

  const currentMode = useMemo(() => modeConfigs[activeMode], [activeMode]);

  const handleCreateRoom = async () => {
    setIsSubmitting(true);
    setError('');
    setStatusMessage(currentMode.createStatus);
    try {
      const { data } = await apiClient.post(currentMode.endpoint);
      navigate(`${currentMode.routePrefix}${data.roomId}`);
    } catch (err) {
      setError(err.message || 'Failed to create room.');
      setStatusMessage('');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleJoinRoom = () => {
    const normalized = roomIdInput.trim().toUpperCase();
    if (!normalized) {
      setError('Enter a room ID to continue.');
      return;
    }
    if (normalized.length !== 8) {
      setError('Room IDs are 8 characters long.');
      return;
    }
    setError('');
    setStatusMessage(currentMode.joinStatus);
    navigate(`${currentMode.routePrefix}${normalized}`);
  };

  const handleInputChange = (event) => {
    const nextValue = event.target.value.toUpperCase();
    if (!RoomIdInputMask.test(nextValue)) {
      return;
    }
    setRoomIdInput(nextValue);
  };

  const handleKeyDown = (event) => {
    if (event.key === 'Enter') {
      handleJoinRoom();
    }
  };

  const handleModeChange = (modeId) => {
    if (modeId === activeMode) {
      return;
    }
    setActiveMode(modeId);
    setRoomIdInput('');
    setStatusMessage('');
    setError('');
  };

  return (
    <div className="min-h-screen w-full bg-[#F4EBD9] px-4 py-10 text-[#4A3F35]">
      <div className="mx-auto flex max-w-4xl flex-col gap-10">
        <header className="text-center space-y-3">
          <p className="text-xs uppercase tracking-[0.4em] text-stone-500">Realtime workspace</p>
          <h1 className="text-5xl font-semibold tracking-[0.2em] text-[#3E342B]">WAVY</h1>
          <p className="text-sm text-stone-500">Pick a mode, share the link, and you’re collaborating.</p>
        </header>

        <section className="rounded-[32px] border border-stone-200 bg-[#FDF6E3] shadow-sm p-6 ">
          <div className="flex flex-col gap-8">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-xs uppercase tracking-[0.4em] text-stone-500">Modes</p>
              <div className="inline-flex rounded-full bg-[#FDF6E3]/70 p-1">
                {Object.values(modeConfigs).map((mode) => (
                  <button
                    key={mode.id}
                    type="button"
                    onClick={() => handleModeChange(mode.id)}
                    className={`rounded-full px-4 py-1 text-xs font-semibold uppercase tracking-[0.3em] transition ${
                      activeMode === mode.id ? 'bg-[#4A3F35] text-white' : 'text-stone-500 hover:text-[#3E342B]'
                    }`}
                  >
                    {mode.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="grid gap-6 lg:grid-cols-2">
              <div className="rounded-3xl border border-stone-200 bg-[#FDF6E3]/60 p-6">
                <p className="text-xs uppercase tracking-[0.3em] text-stone-500">{currentMode.title}</p>
                <p className="mt-3 text-3xl font-semibold text-[#3E342B]">{currentMode.description}</p>
                <p className="mt-4 text-sm text-stone-500">
                  Lightweight spaces built for quick collaboration. Switch modes at any time without leaving this page.
                </p>
              </div>

              <div className="rounded-3xl border border-stone-200 bg-[#F4EBD9]/70 p-6">
                <p className="text-xs uppercase tracking-[0.4em] text-stone-500">Access</p>
                <button
                  type="button"
                  disabled={isSubmitting}
                  onClick={handleCreateRoom}
                  className={`mt-4 inline-flex w-full items-center justify-center rounded-2xl  ${currentMode.accent} px-6 py-3 text-lg font-semibold text-[#3E342B] shadow-lg shadow-gray-200 transition hover:shadow-gray-300 disabled:cursor-not-allowed disabled:opacity-70`}
                >
                  {isSubmitting ? 'Working…' : currentMode.createLabel}
                </button>
                <div className="mt-6 space-y-3">
                  <label htmlFor="room-id" className="text-xs uppercase tracking-[0.4em] text-stone-500">
                    Join with code
                  </label>
                  <input
                    id="room-id"
                    type="text"
                    inputMode="text"
                    autoComplete="off"
                    maxLength={8}
                    placeholder="8-character code"
                    value={roomIdInput}
                    onChange={handleInputChange}
                    onKeyDown={handleKeyDown}
                    className="w-full rounded-2xl border border-stone-200 bg-[#FDF6E3] px-4 py-3 text-lg uppercase tracking-[0.3em] text-[#3E342B] placeholder:text-stone-500 focus:border-blue-500"
                  />
                  <button
                    type="button"
                    onClick={handleJoinRoom}
                    className="w-full rounded-2xl border border-stone-300 px-4 py-3 text-lg font-semibold text-[#3E342B] transition hover:bg-[#EAE0C8]"
                  >
                    {currentMode.joinLabel}
                  </button>
                  {(error || statusMessage) && (
                    <p className={`text-xs ${error ? 'text-red-500' : 'text-stone-500'}`}>
                      {error || statusMessage}
                    </p>
                  )}
                </div>
              </div>
            </div>
          </div>
        </section>

        <footer className="flex flex-col items-center gap-3 text-center text-xs uppercase tracking-[0.4em] text-stone-500">
          <p>© 2026 Wavy</p>
          <div className="flex gap-4 text-[10px] tracking-[0.3em]">
            <a
              href="https://www.linkedin.com/in/devlohani/"
              target="_blank"
              rel="noreferrer"
              className="text-stone-600 hover:text-[#3E342B]"
            >
              LinkedIn
            </a>
            <a
              href="https://github.com/devlohani99"
              target="_blank"
              rel="noreferrer"
              className="text-stone-600 hover:text-[#3E342B]"
            >
              GitHub
            </a>
          </div>
        </footer>
      </div>
    </div>
  );
};

export default Home;
