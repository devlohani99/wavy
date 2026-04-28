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
    <div className="flex min-h-screen w-full flex-col items-center justify-center gap-4 bg-[#F4EBD9] px-4 text-center text-[#3E342B]">
      <div className="h-16 w-16 animate-spin rounded-full border-4 border-stone-200 border-t-sky-400" aria-label="Backend loading spinner" />
      <p className="text-sm text-stone-600">{message}</p>
      {error && <p className="text-xs text-red-600">{error}</p>}
      {showRetry && (
        <button
          type="button"
          onClick={retry}
          className="rounded-full border border-white/30 px-6 py-2 text-xs font-semibold uppercase tracking-[0.3em] text-[#4A3F35] transition hover:bg-[#EAE0C8]"
        >
          Retry now
        </button>
      )}
    </div>
  );
};

export default BackendHealthGate;
