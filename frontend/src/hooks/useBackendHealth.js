import { useCallback, useEffect, useRef, useState } from 'react';
import apiClient from '../lib/apiClient.js';

const RETRY_DELAYS_MS = [2000, 4000, 8000, 16000];

const useBackendHealth = () => {
  const [status, setStatus] = useState('checking');
  const [error, setError] = useState('');
  const retryIndexRef = useRef(0);
  const retryTimeoutRef = useRef(null);

  const clearScheduledRetry = useCallback(() => {
    if (retryTimeoutRef.current) {
      clearTimeout(retryTimeoutRef.current);
      retryTimeoutRef.current = null;
    }
  }, []);

  const checkHealth = useCallback(async () => {
    clearScheduledRetry();
    setStatus('checking');
    setError('');
    try {
      await apiClient.get('/health');
      retryIndexRef.current = 0;
      setStatus('ready');
    } catch (err) {
      setError(err.message || 'Unable to reach backend.');
      setStatus('offline');
    }
  }, [clearScheduledRetry]);

  useEffect(() => {
    checkHealth();
    return () => {
      clearScheduledRetry();
    };
  }, [checkHealth, clearScheduledRetry]);

  useEffect(() => {
    if (status !== 'offline') {
      return undefined;
    }
    const delay = RETRY_DELAYS_MS[Math.min(retryIndexRef.current, RETRY_DELAYS_MS.length - 1)];
    retryTimeoutRef.current = setTimeout(() => {
      retryIndexRef.current += 1;
      checkHealth();
    }, delay);
    return () => {
      clearScheduledRetry();
    };
  }, [status, checkHealth, clearScheduledRetry]);

  const retry = useCallback(() => {
    retryIndexRef.current = 0;
    checkHealth();
  }, [checkHealth]);

  return {
    status,
    error,
    isReady: status === 'ready',
    isChecking: status === 'checking',
    retry,
  };
};

export default useBackendHealth;
