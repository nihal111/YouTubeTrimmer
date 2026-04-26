import { Routes, Route, NavLink, Navigate } from 'react-router-dom';
import { Scissors, Film } from 'lucide-react';
import TrimPage from './TrimPage';
import StitchPage from './StitchPage';
import './App.css';

function App() {
  return (
    <>
      <nav className="app-nav">
        <NavLink to="/trim" className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>
          <Scissors size={16} /> Trim
        </NavLink>
        <NavLink to="/stitch" className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>
          <Film size={16} /> Stitch
        </NavLink>
      </nav>
      <Routes>
        <Route path="/" element={<Navigate to="/trim" replace />} />
        <Route path="/trim" element={<TrimPage />} />
        <Route path="/stitch" element={<StitchPage />} />
      </Routes>
    </>
  );
}

export default App;
