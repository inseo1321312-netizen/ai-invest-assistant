import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { applyPrefs, readPrefs } from './prefs';
import './styles.css';

applyPrefs(readPrefs());

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
