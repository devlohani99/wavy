import { Navigate, Route, Routes } from 'react-router-dom';
import AppErrorBoundary from './components/AppErrorBoundary.jsx';
import BackendHealthGate from './components/BackendHealthGate.jsx';
import Home from './pages/Home.jsx';
import Room from './pages/Room.jsx';
import TypingRoom from './pages/TypingRoom.jsx';

function App() {
  return (
    <AppErrorBoundary>
      <BackendHealthGate>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/room/:roomId" element={<Room />} />
          <Route path="/typing/:roomId" element={<TypingRoom />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BackendHealthGate>
    </AppErrorBoundary>
  );
}

export default App;
