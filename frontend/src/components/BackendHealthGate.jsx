import useBackendHealth from '../hooks/useBackendHealth.js';

const statusCopy = {
  checking: 'Checking backend health...',
  offline: 'Backend is waking up on Render. This can take a few seconds.',
};

const BackendHealthGate = ({ children }) => {
  const { status, error, retry } = useBackendHealth();

  if (status === 'ready') {
    return children;
  }

  const message = statusCopy[status] || statusCopy.checking;
  const showRetry = status === 'offline';

  return (
    <div className="flex min-h-screen w-full flex-col items-center justify-center gap-4 bg-[#050914] px-4 text-center text-white">
      <div className="h-16 w-16 animate-spin rounded-full border-4 border-white/10 border-t-sky-400" aria-label="Backend loading spinner" />
      <p className="text-sm text-slate-300">{message}</p>
      {error && <p className="text-xs text-rose-300">{error}</p>}
      {showRetry && (
        <button
          type="button"
          onClick={retry}
          className="rounded-full border border-white/30 px-6 py-2 text-xs font-semibold uppercase tracking-[0.3em] text-slate-100 transition hover:bg-white/10"
        >
          Retry now
        </button>
      )}
    </div>
  );
};

export default BackendHealthGate;
