import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { io } from 'socket.io-client';
import apiClient from '../lib/apiClient.js';

const MIN_USERNAME_LENGTH = 3;
const MAX_USERNAME_LENGTH = 15;
const USERNAME_PATTERN = /^[a-zA-Z0-9 _-]+$/;
const DEFAULT_TIME_LIMIT_SECONDS = 60;
const VOICE_ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];

const calculateWpm = (characters, seconds) => {
  if (!seconds) {
    return 0;
  }
  const words = characters / 5;
  const minutes = seconds / 60;
  return Math.max(0, Math.round(words / minutes));
};

const validateName = (value = '') => {
  const trimmed = value.trim();
  return (
    trimmed.length >= MIN_USERNAME_LENGTH &&
    trimmed.length <= MAX_USERNAME_LENGTH &&
    USERNAME_PATTERN.test(trimmed)
  );
};

const getStoredName = () => {
  if (typeof window === 'undefined') {
    return '';
  }
  try {
    return window.localStorage.getItem('wavyUsername') || '';
  } catch (err) {
    console.warn('Unable to read stored username', err);
    return '';
  }
};

const TypingRoom = () => {
  const { roomId: paramId } = useParams();
  const roomId = (paramId || '').trim().toUpperCase();
  const navigate = useNavigate();

  const initialName = getStoredName();
  const initialNameValid = validateName(initialName);

  const [status, setStatus] = useState('loading');
  const [error, setError] = useState('');
  const [roomInfo, setRoomInfo] = useState(null);
  const [userCount, setUserCount] = useState(0);
  const [leaderboard, setLeaderboard] = useState([]);
  const [typedText, setTypedText] = useState('');
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [currentWpm, setCurrentWpm] = useState(0);
  const [isCompleted, setIsCompleted] = useState(false);
  const [hasTimedOut, setHasTimedOut] = useState(false);
  const [timeRemaining, setTimeRemaining] = useState(DEFAULT_TIME_LIMIT_SECONDS);
  const [toastMessage, setToastMessage] = useState('');
  const [voicePeers, setVoicePeers] = useState({});
  const [isVoiceEnabled, setIsVoiceEnabled] = useState(false);
  const [voiceStatus, setVoiceStatus] = useState('idle');
  const [isMuted, setIsMuted] = useState(false);
  const [clientSocketId, setClientSocketId] = useState('');
  const [nameInput, setNameInput] = useState(initialName);
  const [nameError, setNameError] = useState('');
  const [confirmedName, setConfirmedName] = useState(initialNameValid ? initialName.trim() : '');
  const [isNameConfirmed, setIsNameConfirmed] = useState(initialNameValid);
  const [isNameModalOpen, setIsNameModalOpen] = useState(!initialNameValid);

  const socketRef = useRef(null);
  const timerIntervalRef = useRef(null);
  const typingStartedAtRef = useRef(null);
  const toastTimeoutRef = useRef(null);
  const localStreamRef = useRef(null);
  const peerConnectionsRef = useRef(new Map());
  const voiceAnalyzersRef = useRef(new Map());
  const audioRefs = useRef(new Map());
  const pendingIceCandidatesRef = useRef(new Map());
  const typedTextRef = useRef('');
  const hasTimedOutRef = useRef(false);

  useEffect(() => {
    typedTextRef.current = typedText;
  }, [typedText]);

  useEffect(() => {
    hasTimedOutRef.current = hasTimedOut;
  }, [hasTimedOut]);
  const localVoiceKeyRef = useRef(null);

  const usernameRef = useRef(confirmedName);
  useEffect(() => {
    usernameRef.current = confirmedName;
  }, [confirmedName]);

  const currentTimeLimit = useMemo(() => roomInfo?.timeLimitSeconds || DEFAULT_TIME_LIMIT_SECONDS, [roomInfo?.timeLimitSeconds]);

  const voiceEnabledRef = useRef(isVoiceEnabled);
  useEffect(() => {
    voiceEnabledRef.current = isVoiceEnabled;
  }, [isVoiceEnabled]);

  const voicePeersSnapshotRef = useRef(voicePeers);
  useEffect(() => {
    voicePeersSnapshotRef.current = voicePeers;
  }, [voicePeers]);

  const isNameConfirmedRef = useRef(isNameConfirmed);
  useEffect(() => {
    isNameConfirmedRef.current = isNameConfirmed;
  }, [isNameConfirmed]);

  const showToast = useCallback((message) => {
    if (!message) {
      return;
    }
    setToastMessage(message);
    if (toastTimeoutRef.current) {
      clearTimeout(toastTimeoutRef.current);
    }
    toastTimeoutRef.current = setTimeout(() => {
      setToastMessage('');
    }, 2200);
  }, []);

  const handleTimeExpired = useCallback(
    (source = 'client') => {
      if (hasTimedOutRef.current || isCompleted) {
        return;
      }
      hasTimedOutRef.current = true;
      setHasTimedOut(true);
      setTimeRemaining(0);
      showToast('Time is up!');
      if (timerIntervalRef.current) {
        clearInterval(timerIntervalRef.current);
        timerIntervalRef.current = null;
      }
      if (source === 'client') {
        socketRef.current?.emit('typing-update', {
          value: typedTextRef.current,
          delta: 0,
          isTimeoutPing: true,
        });
      }
    },
    [isCompleted, showToast],
  );

  const stopSpeakingMonitor = useCallback((peerId) => {
    const entry = voiceAnalyzersRef.current.get(peerId);
    if (!entry) {
      return;
    }
    if (entry.rafId) {
      cancelAnimationFrame(entry.rafId);
    }
    if (entry.audioCtx && entry.audioCtx.state !== 'closed') {
      entry.audioCtx.close().catch(() => null);
    }
    voiceAnalyzersRef.current.delete(peerId);
  }, []);

  const startSpeakingMonitor = useCallback(
    (peerId, stream) => {
      if (!stream) {
        return;
      }
      stopSpeakingMonitor(peerId);
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) {
        return;
      }
      try {
        const audioCtx = new AudioCtx();
        const source = audioCtx.createMediaStreamSource(stream);
        const analyser = audioCtx.createAnalyser();
        analyser.fftSize = 256;
        source.connect(analyser);
        const dataArray = new Uint8Array(analyser.frequencyBinCount);
        const entry = { audioCtx, analyser, dataArray, rafId: null };
        const tick = () => {
          analyser.getByteFrequencyData(dataArray);
          const average = dataArray.reduce((sum, value) => sum + value, 0) / dataArray.length;
          const speaking = average > 28;
          setVoicePeers((prev) => {
            const peer = prev[peerId];
            if (!peer || peer.isSpeaking === speaking) {
              return prev;
            }
            return {
              ...prev,
              [peerId]: { ...peer, isSpeaking: speaking },
            };
          });
          entry.rafId = requestAnimationFrame(tick);
        };
        entry.rafId = requestAnimationFrame(tick);
        voiceAnalyzersRef.current.set(peerId, entry);
      } catch (voiceErr) {
        console.error('Unable to monitor speaking state', voiceErr);
      }
    },
    [stopSpeakingMonitor],
  );

  const removeVoicePeer = useCallback(
    (peerId) => {
      const pc = peerConnectionsRef.current.get(peerId);
      if (pc) {
        pc.close();
        peerConnectionsRef.current.delete(peerId);
      }
      stopSpeakingMonitor(peerId);
      setVoicePeers((prev) => {
        if (!prev[peerId]) {
          return prev;
        }
        const next = { ...prev };
        delete next[peerId];
        return next;
      });
    },
    [stopSpeakingMonitor],
  );

  const cleanupVoiceResources = useCallback(() => {
    peerConnectionsRef.current.forEach((pc) => pc.close());
    peerConnectionsRef.current.clear();
    voiceAnalyzersRef.current.forEach((entry, peerId) => {
      if (entry.rafId) {
        cancelAnimationFrame(entry.rafId);
      }
      if (entry.audioCtx && entry.audioCtx.state !== 'closed') {
        entry.audioCtx.close().catch(() => null);
      }
      voiceAnalyzersRef.current.delete(peerId);
    });
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((track) => track.stop());
      localStreamRef.current = null;
    }
    audioRefs.current.clear();
    localVoiceKeyRef.current = null;
    setVoicePeers({});
    setIsVoiceEnabled(false);
    setVoiceStatus('idle');
    setIsMuted(false);
  }, []);

  useEffect(() => () => {
    cleanupVoiceResources();
    if (toastTimeoutRef.current) {
      clearTimeout(toastTimeoutRef.current);
    }
  }, [cleanupVoiceResources]);

  useEffect(() => {
    setTypedText('');
    typedTextRef.current = '';
    setElapsedSeconds(0);
    setCurrentWpm(0);
    setIsCompleted(false);
    setHasTimedOut(false);
    hasTimedOutRef.current = false;
    setTimeRemaining(DEFAULT_TIME_LIMIT_SECONDS);
    if (timerIntervalRef.current) {
      clearInterval(timerIntervalRef.current);
      timerIntervalRef.current = null;
    }
    typingStartedAtRef.current = null;
  }, [roomId]);

  const applyServerReset = useCallback((nextTimeLimitSeconds) => {
    const resolvedLimit = nextTimeLimitSeconds || DEFAULT_TIME_LIMIT_SECONDS;
    setTypedText('');
    typedTextRef.current = '';
    setElapsedSeconds(0);
    setCurrentWpm(0);
    setIsCompleted(false);
    setHasTimedOut(false);
    hasTimedOutRef.current = false;
    setTimeRemaining(resolvedLimit);
    if (timerIntervalRef.current) {
      clearInterval(timerIntervalRef.current);
      timerIntervalRef.current = null;
    }
    typingStartedAtRef.current = null;
  }, []);

  useEffect(() => {
    let isMounted = true;
    setStatus('loading');
    apiClient
      .get(`/api/typing/${roomId}`)
      .then(({ data }) => {
        if (!isMounted) {
          return;
        }
        setRoomInfo(data);
        setTimeRemaining(data?.timeLimitSeconds || DEFAULT_TIME_LIMIT_SECONDS);
        setHasTimedOut(false);
        hasTimedOutRef.current = false;
        typingStartedAtRef.current = null;
        if (timerIntervalRef.current) {
          clearInterval(timerIntervalRef.current);
          timerIntervalRef.current = null;
        }
        setElapsedSeconds(0);
        setIsCompleted(false);
        setTypedText('');
        typedTextRef.current = '';
        setStatus('ready');
      })
      .catch((err) => {
        if (!isMounted) {
          return;
        }
        setError(err.message || 'Unable to load typing room.');
        setStatus('error');
      });

    return () => {
      isMounted = false;
    };
  }, [roomId]);

  const initiatePeerConnection = useCallback(
    async (peerId, username, isInitiator = false) => {
      if (!localStreamRef.current || !peerId) {
        return null;
      }
      let connection = peerConnectionsRef.current.get(peerId);
      if (!connection) {
        connection = new RTCPeerConnection({ iceServers: VOICE_ICE_SERVERS });
        peerConnectionsRef.current.set(peerId, connection);
        localStreamRef.current.getTracks().forEach((track) => connection.addTrack(track, localStreamRef.current));

        connection.ontrack = (event) => {
          const [stream] = event.streams;
          if (!stream) {
            return;
          }
          setVoicePeers((prev) => ({
            ...prev,
            [peerId]: {
              socketId: peerId,
              username: username || prev[peerId]?.username || 'Guest',
              isLocal: false,
              stream,
              isSpeaking: false,
            },
          }));
          startSpeakingMonitor(peerId, stream);
        };

        connection.onicecandidate = (event) => {
          if (event.candidate) {
            socketRef.current?.emit('typing-voice-ice', { targetId: peerId, candidate: event.candidate });
          }
        };

        connection.onconnectionstatechange = () => {
          if (['failed', 'disconnected', 'closed'].includes(connection.connectionState)) {
            removeVoicePeer(peerId);
          }
        };
      }

      if (isInitiator) {
        const offer = await connection.createOffer();
        await connection.setLocalDescription(offer);
        socketRef.current?.emit('typing-voice-offer', { targetId: peerId, offer });
      }

      return connection;
    },
    [removeVoicePeer, startSpeakingMonitor],
  );

  const flushPendingIce = useCallback(async (peerId, connection) => {
    if (!connection) {
      return;
    }
    const pending = pendingIceCandidatesRef.current.get(peerId);
    if (!pending?.length) {
      return connection;
    }
    while (pending.length) {
      const candidate = pending.shift();
      try {
        await connection.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (iceErr) {
        console.error('Deferred ICE candidate error', iceErr);
        break;
      }
    }
    if (!pending.length) {
      pendingIceCandidatesRef.current.delete(peerId);
    }
  }, []);

  useEffect(() => {
    if (status !== 'ready') {
      return undefined;
    }
    const backendUrl = import.meta.env.VITE_BACKEND_URL || window.location.origin;
    const socket = io(backendUrl, {
      transports: ['websocket'],
      withCredentials: true,
    });
    socketRef.current = socket;

    socket.on('connect', () => {
      setClientSocketId(socket.id);
      if (isNameConfirmedRef.current) {
        socket.emit('join-typing-room', { roomId, username: usernameRef.current });
      }
    });

    socket.on('typing-room-error', ({ message }) => {
      setError(message || 'Unable to join typing room.');
      setStatus('error');
    });

    socket.on('typing-users-update', ({ count }) => {
      setUserCount(count || 0);
    });

    socket.on('leaderboard-update', ({ leaderboard: payload, roundNumber, totalRounds }) => {
      setLeaderboard(payload || []);
      if (roundNumber && totalRounds) {
        setRoomInfo((prev) => (prev ? { ...prev, roundNumber, totalRounds } : prev));
      }
    });

    socket.on('user-finished', ({ username }) => {
      if (username) {
        showToast(`${username} finished!`);
      }
    });

    socket.on('typing-room-ready', (payload) => {
      if (!payload) {
        return;
      }
      setRoomInfo((prev) => ({ ...prev, ...payload }));
      applyServerReset(payload.timeLimitSeconds);
    });

    socket.on('typing-timeup', () => {
      handleTimeExpired('server');
    });

    socket.on('user-timeup', ({ username }) => {
      if (username) {
        showToast(`${username} ran out of time`);
      }
    });

    socket.on('voice-error', ({ message }) => {
      showToast(message || 'Voice chat unavailable');
      setVoiceStatus('error');
    });

    socket.on('voice-participants', ({ participants }) => {
      if (!voiceEnabledRef.current) {
        return;
      }
      const list = Array.isArray(participants) ? participants : [];
      list.forEach((participant) => {
        if (!participant?.socketId) {
          return;
        }
        setVoicePeers((prev) => ({
          ...prev,
          [participant.socketId]: {
            socketId: participant.socketId,
            username: participant.username || 'Guest',
            isLocal: false,
            stream: prev[participant.socketId]?.stream || null,
            isSpeaking: false,
          },
        }));
        initiatePeerConnection(participant.socketId, participant.username, true);
      });
      setVoiceStatus('active');
    });

    socket.on('voice-user-joined', ({ socketId, username }) => {
      if (!voiceEnabledRef.current || !socketId) {
        return;
      }
      setVoicePeers((prev) => ({
        ...prev,
        [socketId]: {
          socketId,
          username: username || 'Guest',
          isLocal: false,
          stream: prev[socketId]?.stream || null,
          isSpeaking: false,
        },
      }));
      setVoiceStatus('active');
    });

    socket.on('voice-user-left', ({ socketId }) => {
      if (!socketId) {
        return;
      }
      removeVoicePeer(socketId);
    });

    socket.on('typing-voice-offer', async ({ fromId, offer }) => {
      if (!voiceEnabledRef.current || !fromId || !offer) {
        return;
      }
      const connection = await initiatePeerConnection(
        fromId,
        voicePeersSnapshotRef.current[fromId]?.username,
        false,
      );
      if (!connection) {
        return;
      }
      await connection.setRemoteDescription(new RTCSessionDescription(offer));
      const answer = await connection.createAnswer();
      await connection.setLocalDescription(answer);
      socket.emit('typing-voice-answer', { targetId: fromId, answer });
      await flushPendingIce(fromId, connection);
    });

    socket.on('typing-voice-answer', async ({ fromId, answer }) => {
      if (!voiceEnabledRef.current || !fromId || !answer) {
        return;
      }
      const connection = peerConnectionsRef.current.get(fromId);
      if (!connection) {
        return;
      }
      await connection.setRemoteDescription(new RTCSessionDescription(answer));
      await flushPendingIce(fromId, connection);
    });

    socket.on('typing-voice-ice', async ({ fromId, candidate }) => {
      if (!voiceEnabledRef.current || !fromId || !candidate) {
        return;
      }
      const connection = peerConnectionsRef.current.get(fromId);
      if (!connection) {
        const pending = pendingIceCandidatesRef.current.get(fromId) || [];
        pending.push(candidate);
        pendingIceCandidatesRef.current.set(fromId, pending);
        return;
      }
      try {
        await connection.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (iceErr) {
        console.error('ICE candidate error', iceErr);
        const pending = pendingIceCandidatesRef.current.get(fromId) || [];
        pending.push(candidate);
        pendingIceCandidatesRef.current.set(fromId, pending);
      }
    });

    return () => {
      socket.emit('leave-voice');
      socket.emit('leave-typing-room');
      socket.disconnect();
      socketRef.current = null;
      cleanupVoiceResources();
    };
  }, [applyServerReset, cleanupVoiceResources, flushPendingIce, handleTimeExpired, initiatePeerConnection, removeVoicePeer, roomId, showToast, status]);

  useEffect(() => {
    if (status === 'ready' && isNameConfirmed && socketRef.current?.connected) {
      socketRef.current.emit('join-typing-room', { roomId, username: usernameRef.current });
    }
  }, [isNameConfirmed, roomId, status]);

  useEffect(
    () => () => {
      if (timerIntervalRef.current) {
        clearInterval(timerIntervalRef.current);
        timerIntervalRef.current = null;
      }
    },
    [],
  );

  useEffect(() => {
    if (isCompleted && timerIntervalRef.current) {
      clearInterval(timerIntervalRef.current);
      timerIntervalRef.current = null;
    }
  }, [isCompleted]);

  const handleBlockedInteraction = useCallback(
    (event) => {
      event.preventDefault();
      showToast('Copy/Paste is not allowed');
    },
    [showToast],
  );

  const handleKeyDownGuard = useCallback(
    (event) => {
      if (event.ctrlKey || event.metaKey) {
        const blockedKeys = ['c', 'x', 'v', 'C', 'X', 'V'];
        if (blockedKeys.includes(event.key)) {
          event.preventDefault();
          showToast('Copy/Paste is not allowed');
        }
      }
    },
    [showToast],
  );

  const handleInputChange = (event) => {
    if (!isNameConfirmed || status !== 'ready' || !roomInfo?.text) {
      showToast('Choose a name before typing');
      return;
    }
    if (isCompleted || hasTimedOut) {
      return;
    }
    if (!typingStartedAtRef.current) {
      typingStartedAtRef.current = Date.now();
      setElapsedSeconds(0);
      setTimeRemaining(currentTimeLimit);
      if (!timerIntervalRef.current) {
        timerIntervalRef.current = setInterval(() => {
          const elapsed = Math.max(0, Math.floor((Date.now() - typingStartedAtRef.current) / 1000));
          setElapsedSeconds(elapsed);
          const remaining = Math.max(0, currentTimeLimit - elapsed);
          setTimeRemaining(remaining);
          if (remaining <= 0) {
            handleTimeExpired('client');
          }
        }, 1000);
      }
    }

    const nextValue = event.target.value;
    setTypedText(nextValue);

    const seconds = Math.max(1, Math.floor((Date.now() - typingStartedAtRef.current) / 1000));
    const wpm = calculateWpm(nextValue.length, seconds);
    setCurrentWpm(wpm);

    const targetLength = promptLength || Infinity;
    if (nextValue.length >= targetLength) {
      setIsCompleted(true);
    }

    const delta = nextValue.length - typedText.length;
    const isPaste = event.nativeEvent?.inputType === 'insertFromPaste';
    socketRef.current?.emit('typing-update', {
      value: nextValue,
      delta,
      isPaste,
    });
  };

  const handleLeaveRoom = () => {
    socketRef.current?.emit('leave-typing-room');
    socketRef.current?.emit('leave-voice');
    cleanupVoiceResources();
    navigate('/');
  };

  const handleSaveName = () => {
    if (!validateName(nameInput)) {
      setNameError(`Name must be ${MIN_USERNAME_LENGTH}-${MAX_USERNAME_LENGTH} characters (letters, numbers, space, - or _)`);
      return;
    }
    const trimmed = nameInput.trim();
    setConfirmedName(trimmed);
    setIsNameConfirmed(true);
    setIsNameModalOpen(false);
    setNameError('');
    try {
      window.localStorage.setItem('wavyUsername', trimmed);
    } catch (storageErr) {
      console.warn('Unable to store username', storageErr);
    }
    if (socketRef.current?.connected) {
      socketRef.current.emit('join-typing-room', { roomId, username: trimmed });
    }
  };

  const handleEnableVoice = async () => {
    if (isVoiceEnabled) {
      cleanupVoiceResources();
      socketRef.current?.emit('leave-voice');
      return;
    }
    if (!socketRef.current) {
      showToast('Connect to the room first');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      localStreamRef.current = stream;
      stream.getAudioTracks().forEach((track) => {
        track.enabled = !isMuted;
      });
      const localId = socketRef.current?.id || clientSocketId || 'local-self';
      localVoiceKeyRef.current = localId;
      setVoicePeers((prev) => ({
        ...prev,
        [localId]: {
          socketId: localId,
          username: confirmedName || 'You',
          isLocal: true,
          stream,
          isSpeaking: false,
        },
      }));
      startSpeakingMonitor(localId, stream);
      setIsVoiceEnabled(true);
      setVoiceStatus('connecting');
      socketRef.current.emit('join-voice');
    } catch (voiceErr) {
      console.error('Microphone permission denied', voiceErr);
      setVoiceStatus('error');
      showToast('Microphone permission denied');
    }
  };

  const handleToggleMute = () => {
    if (!localStreamRef.current) {
      return;
    }
    const nextMuted = !isMuted;
    localStreamRef.current.getAudioTracks().forEach((track) => {
      track.enabled = !nextMuted;
    });
    setIsMuted(nextMuted);
  };

  const promptLength = roomInfo?.text ? roomInfo.text.length : 0;

  const progressPercent = useMemo(() => {
    if (!promptLength) {
      return 0;
    }
    return Math.min(100, Math.round((typedText.length / promptLength) * 100));
  }, [promptLength, typedText.length]);

  const promptSegments = useMemo(() => {
    const text = roomInfo?.text || '';
    if (!text) {
      return [];
    }
    const tokens = text.match(/\s+|\S+/g) || [];
    let cursor = 0;
    return tokens.map((token, index) => {
      const tokenLength = token.length;
      const typedSlice = typedText.slice(cursor, cursor + tokenLength);
      const isWhitespace = /^\s+$/.test(token);
      let status = 'space';
      if (!isWhitespace) {
        if (!typedSlice.length) {
          status = 'upcoming';
        } else if (typedSlice.length >= tokenLength) {
          status = typedSlice === token ? 'completed' : 'error';
        } else {
          const reference = token.slice(0, typedSlice.length);
          status = typedSlice === reference ? 'current' : 'error';
        }
      }
      cursor += tokenLength;
      return {
        key: `segment-${index}`,
        text: token,
        status,
      };
    });
  }, [roomInfo?.text, typedText]);

  const promptClassMap = {
    completed: 'text-slate-500',
    current: 'text-sky-300',
    upcoming: 'text-slate-200',
    error: 'text-rose-300 underline decoration-rose-400',
    space: '',
  };

  const formattedLeaderboard = useMemo(
    () =>
      leaderboard.map((entry, index) => ({
        position: index + 1,
        username: entry.username,
        score: entry.score || 0,
        isSelf: entry.username === confirmedName,
        isCompleted: Boolean(entry.isCompleted),
        completionTime: entry.completionTime,
        isFlagged: Boolean(entry.isFlagged),
        isTimeUp: Boolean(entry.isTimeUp),
        statusLabel: entry.isTimeUp ? '⌛ Time up' : entry.isCompleted ? '✅ Completed' : '⏳ Typing',
      })),
    [confirmedName, leaderboard],
  );

  const voicePeerEntries = useMemo(() => Object.values(voicePeers), [voicePeers]);

  useEffect(() => {
    if (!isVoiceEnabled || !clientSocketId) {
      return;
    }
    if (localVoiceKeyRef.current === clientSocketId) {
      return;
    }
    setVoicePeers((prev) => {
      const current = prev[localVoiceKeyRef.current];
      if (!current) {
        return prev;
      }
      const next = { ...prev };
      delete next[localVoiceKeyRef.current];
      next[clientSocketId] = { ...current, socketId: clientSocketId };
      return next;
    });
    localVoiceKeyRef.current = clientSocketId;
  }, [clientSocketId, isVoiceEnabled]);

  useEffect(() => {
    if (!isVoiceEnabled) {
      return;
    }
    const localKey = localVoiceKeyRef.current || clientSocketId;
    if (!localKey) {
      return;
    }
    setVoicePeers((prev) => {
      const current = prev[localKey];
      if (!current || current.username === confirmedName) {
        return prev;
      }
      return {
        ...prev,
        [localKey]: { ...current, username: confirmedName },
      };
    });
  }, [clientSocketId, confirmedName, isVoiceEnabled]);

  useEffect(() => {
    voicePeerEntries.forEach((peer) => {
      if (!peer.stream) {
        return;
      }
      const ref = audioRefs.current.get(peer.socketId);
      if (ref && ref.srcObject !== peer.stream) {
        ref.srcObject = peer.stream;
        const playPromise = ref.play();
        if (playPromise && typeof playPromise.catch === 'function') {
          playPromise.catch(() => {
            /* autoplay guard */
          });
        }
      }
    });
  }, [voicePeerEntries]);

  if (status === 'loading') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-950 text-slate-100">
        <p>Loading room…</p>
      </div>
    );
  }

  if (status === 'error') {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-4 bg-slate-950 text-slate-100">
        <p className="text-2xl font-semibold">Unable to join typing room.</p>
        <p className="text-slate-400">{error}</p>
        <button
          type="button"
          onClick={() => navigate('/')}
          className="rounded-full border border-white/20 px-5 py-2 text-sm text-white hover:bg-white/10"
        >
          Back to home
        </button>
      </div>
    );
  }

  return (
    <div className="relative min-h-screen bg-slate-950 text-slate-100 flex flex-col">
      {toastMessage && (
        <div className="pointer-events-none absolute left-1/2 top-6 z-20 -translate-x-1/2 rounded-full border border-white/20 bg-slate-900/90 px-6 py-2 text-sm text-white shadow-lg">
          {toastMessage}
        </div>
      )}

      {isNameModalOpen && (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-slate-950/90 px-4">
          <div className="w-full max-w-md rounded-3xl border border-white/10 bg-slate-900 p-6 text-left">
            <p className="text-xs uppercase tracking-[0.4em] text-slate-400">Choose a name</p>
            <h2 className="mt-2 text-2xl font-semibold text-white">This is how others see you</h2>
            <input
              value={nameInput}
              onChange={(event) => {
                setNameInput(event.target.value);
                setNameError('');
              }}
              maxLength={MAX_USERNAME_LENGTH}
              className="mt-5 w-full rounded-2xl border border-white/15 bg-slate-950 px-4 py-3 text-lg text-white placeholder:text-slate-500 focus:border-sky-400"
              placeholder="e.g. NovaScribe"
            />
            <div className="mt-2 flex items-center justify-between text-xs text-slate-500">
              <span>
                {nameInput.length}/{MAX_USERNAME_LENGTH} chars
              </span>
              <span>Letters, numbers, space, -, _</span>
            </div>
            {nameError && <p className="mt-2 text-sm text-rose-400">{nameError}</p>}
            <button
              type="button"
              onClick={handleSaveName}
              className="mt-5 w-full rounded-full bg-white px-5 py-3 text-center text-slate-900 font-semibold"
            >
              Save name
            </button>
          </div>
        </div>
      )}

      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 px-5 py-4">
        <div>
          <p className="text-xs uppercase tracking-[0.4em] text-slate-400">Typing room</p>
          <div className="mt-1 flex flex-wrap items-center gap-3">
            <span className="text-2xl font-semibold tracking-[0.3em]">{roomId}</span>
            <button
              type="button"
              onClick={() => navigator.clipboard.writeText(window.location.href)}
              className="rounded-full border border-white/20 px-3 py-1 text-xs uppercase tracking-[0.4em] text-slate-200 hover:bg-white/10"
            >
              Copy link
            </button>
            <button
              type="button"
              onClick={() => {
                setIsNameModalOpen(true);
                setNameInput(confirmedName);
                setNameError('');
              }}
              className="rounded-full border border-white/20 px-3 py-1 text-xs uppercase tracking-[0.4em] text-slate-200 hover:bg-white/10"
            >
              Edit name
            </button>
          </div>
        </div>
        <div className="text-right space-y-1">
          <p className="text-sm text-slate-300">Users online: {userCount}</p>
          <p className={`text-sm ${timeRemaining <= 10 ? 'text-rose-300' : 'text-slate-300'}`}>
            Time left: {timeRemaining}s
          </p>
          <button
            type="button"
            onClick={handleLeaveRoom}
            className="mt-2 rounded-full border border-rose-400/60 px-4 py-1 text-sm text-rose-200 hover:bg-rose-500/10"
          >
            Leave
          </button>
        </div>
      </header>

      <main className="flex flex-1 flex-col gap-6 p-5 lg:flex-row">
        <section className="flex-1 rounded-3xl border border-white/10 bg-white/5/10 p-5 backdrop-blur-xl">
          <div className="flex items-center justify-between text-xs uppercase tracking-[0.4em] text-slate-400">
            <span>
              Prompt · Round {roomInfo?.roundNumber || 1}/{roomInfo?.totalRounds || 1}
            </span>
            {roomInfo?.text && <span>{progressPercent}% complete</span>}
          </div>
          <p className="mt-3 text-lg leading-relaxed text-slate-100">
            {promptSegments.length
              ? promptSegments.map((segment) => (
                  <span key={segment.key} className={promptClassMap[segment.status]}>
                    {segment.text}
                  </span>
                ))
              : roomInfo?.text}
          </p>

          <div
            className="mt-6 rounded-2xl border border-white/10 bg-slate-900/60 p-4"
            onContextMenu={handleBlockedInteraction}
          >
            <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-slate-400">
              <span>Typing as {confirmedName || 'Guest'}</span>
              <span>{currentWpm} WPM</span>
            </div>
            <textarea
              value={typedText}
              onChange={handleInputChange}
              placeholder={isNameConfirmed ? 'Start typing here…' : 'Pick a name to begin'}
              onPaste={handleBlockedInteraction}
              onCopy={handleBlockedInteraction}
              onCut={handleBlockedInteraction}
              onKeyDown={handleKeyDownGuard}
              disabled={!isNameConfirmed || isCompleted || status !== 'ready' || hasTimedOut}
              className="mt-3 h-40 w-full resize-none rounded-2xl border border-white/10 bg-slate-950/80 px-4 py-3 text-base text-white placeholder:text-slate-600 focus:border-sky-400 disabled:cursor-not-allowed"
            />
            {elapsedSeconds > 0 && (
              <p className="mt-2 text-xs text-slate-400">Elapsed: {elapsedSeconds}s</p>
            )}
            {isCompleted && (
              <div className="mt-2 rounded-xl border border-emerald-400/40 bg-emerald-500/10 px-4 py-2 text-sm text-emerald-200">
                You finished!
              </div>
            )}
            {hasTimedOut && (
              <div className="mt-2 rounded-xl border border-rose-400/40 bg-rose-500/10 px-4 py-2 text-sm text-rose-100">
                Time is up. Results are locked.
              </div>
            )}
          </div>
        </section>

        <aside className="w-full space-y-5 rounded-3xl border border-white/10 bg-white/5/10 p-5 backdrop-blur-xl lg:w-96">
          <div>
            <p className="text-xs uppercase tracking-[0.4em] text-slate-400">Score leaderboard</p>
            <div className="mt-4 space-y-3">
              {formattedLeaderboard.length === 0 && (
                <p className="text-sm text-slate-500">Waiting for typists…</p>
              )}
              {formattedLeaderboard.map((entry) => (
                <div
                  key={`${entry.username}-${entry.position}`}
                  className={`rounded-2xl border px-4 py-3 text-sm ${
                    entry.isSelf
                      ? 'border-sky-400 bg-sky-500/10 text-white'
                      : entry.isTimeUp
                        ? 'border-amber-400/40 bg-amber-500/10 text-amber-100'
                        : 'border-white/10 text-slate-200'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span>
                      {entry.position}. {entry.username}
                    </span>
                    <span className="font-semibold">{entry.score} pts</span>
                  </div>
                  <div className="mt-1 flex items-center gap-2 text-xs">
                    <span>{entry.statusLabel}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-2xl border border-white/10 bg-slate-950/60 p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs uppercase tracking-[0.4em] text-slate-400">Voice chat</p>
                <p className="text-sm text-slate-300">{voiceStatus === 'idle' ? 'Off' : voiceStatus}</p>
              </div>
              <button
                type="button"
                onClick={handleEnableVoice}
                disabled={!socketRef.current || !clientSocketId}
                className={`rounded-full px-4 py-1 text-xs font-semibold uppercase tracking-[0.3em] ${
                  isVoiceEnabled ? 'border border-rose-400/60 text-rose-200' : 'border border-sky-400/60 text-sky-200'
                } disabled:cursor-not-allowed disabled:opacity-50`}
              >
                {isVoiceEnabled ? 'Leave' : 'Join'}
              </button>
            </div>
            {isVoiceEnabled && (
              <div className="mt-3 space-y-3">
                <button
                  type="button"
                  onClick={handleToggleMute}
                  className="w-full rounded-full border border-white/10 px-4 py-2 text-sm text-white hover:border-white/40"
                >
                  {isMuted ? 'Unmute mic' : 'Mute mic'}
                </button>
                <div className="space-y-3">
                  {voicePeerEntries.map((peer) => (
                    <div
                      key={peer.socketId}
                      className={`flex items-center justify-between rounded-2xl border px-4 py-2 text-sm ${
                        peer.isSpeaking ? 'border-emerald-400 bg-emerald-500/10' : 'border-white/10'
                      }`}
                    >
                      <div>
                        <p className="font-semibold text-white">{peer.isLocal ? `${peer.username} (You)` : peer.username}</p>
                        <p className="text-xs text-slate-400">{peer.isSpeaking ? 'Speaking' : 'Idle'}</p>
                      </div>
                      <audio
                        ref={(element) => {
                          if (element) {
                            audioRefs.current.set(peer.socketId, element);
                            if (peer.stream && element.srcObject !== peer.stream) {
                              element.srcObject = peer.stream;
                            }
                          } else {
                            audioRefs.current.delete(peer.socketId);
                          }
                        }}
                        autoPlay
                        muted={peer.isLocal}
                        playsInline
                        className="hidden"
                      />
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </aside>
      </main>

    </div>
  );
};

export default TypingRoom;
