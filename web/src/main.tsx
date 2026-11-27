import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { applyPrefs, readPrefs } from './prefs';
import { watchForUpdates } from './swUpdate';
import './styles.css';

applyPrefs(readPrefs());
watchForUpdates();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
