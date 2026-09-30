import React from 'react';
import ReactDOM from 'react-dom/client';
import '@fontsource/manrope/latin-400.css';
import '@fontsource/manrope/latin-600.css';
import '@fontsource/manrope/latin-700.css';
import '@fontsource/manrope/latin-800.css';
import '@fontsource/source-sans-3/latin-400.css';
import '@fontsource/source-sans-3/latin-500.css';
import '@fontsource/source-sans-3/latin-600.css';
import '@fontsource/source-sans-3/latin-700.css';
import App from './App';
import PrivacyPage from './components/PrivacyPage';
import LandingPage from './components/LandingPage';
import { initialPage } from './lib/navigation';
import './styles.css';
import './landing.css';
import './workspace-polish.css';

const route = initialPage(window.location);
if (route.replacePath) window.history.replaceState(window.history.state, '', route.replacePath);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {route.page === 'privacy' ? (
      <PrivacyPage />
    ) : route.page === 'workspace' ? (
      <App />
    ) : (
      <LandingPage />
    )}
  </React.StrictMode>,
);
