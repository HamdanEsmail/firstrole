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
import './styles.css';

const isPrivacyPage = window.location.pathname.replace(/\/+$/, '') === '/privacy';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>{isPrivacyPage ? <PrivacyPage /> : <App />}</React.StrictMode>,
);
