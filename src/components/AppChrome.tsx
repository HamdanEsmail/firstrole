import {
  ArrowRight,
  Cloud,
  ExternalLink,
  Layers3,
  LoaderCircle,
  Monitor,
  UserRound,
  X,
  CheckCircle2,
} from 'lucide-react';

export type WorkspaceView = 'find' | 'saved' | 'applications';
export type WorkspaceOverlay =
  'signin' | 'account' | 'how' | 'compare' | 'privacy' | 'delete' | null;
export interface WorkspaceUser {
  id: string;
  email?: string;
  name?: string;
}

interface HeaderProps {
  view: WorkspaceView;
  savedCount: number;
  user: WorkspaceUser | null;
  navigate: (view: WorkspaceView) => void;
  setOverlay: (overlay: WorkspaceOverlay) => void;
}
export function AppHeader({ view, savedCount, user, navigate, setOverlay }: HeaderProps) {
  return (
    <header className="site-header">
      <div className="header-inner">
        <button className="wordmark" onClick={() => navigate('find')} aria-label="FirstRole home">
          First<span>Role</span>
        </button>
        <nav aria-label="Main navigation">
          <button className={view === 'find' ? 'active' : ''} onClick={() => navigate('find')}>
            Find jobs
          </button>
          <button className={view === 'saved' ? 'active' : ''} onClick={() => navigate('saved')}>
            Saved
            {savedCount > 0 && <span className="nav-count">{savedCount}</span>}
          </button>
          <button
            className={view === 'applications' ? 'active' : ''}
            onClick={() => navigate('applications')}
          >
            Applications
          </button>
        </nav>
        <div className="header-actions">
          <button className="how-link" onClick={() => setOverlay('how')}>
            How it works
          </button>
          <button
            className="account-button"
            onClick={() => setOverlay(user ? 'account' : 'signin')}
          >
            <UserRound size={21} />
            <span>{user ? user.name?.split(' ')[0] || 'Account' : 'Sign in'}</span>
          </button>
        </div>
      </div>
    </header>
  );
}

interface FooterProps {
  syncing: boolean;
  signedIn: boolean;
  navigate: (view: WorkspaceView) => void;
  setOverlay: (overlay: WorkspaceOverlay) => void;
}
export function AppFooter({ syncing, signedIn, navigate, setOverlay }: FooterProps) {
  return (
    <footer className="site-footer">
      <button className="wordmark small-logo" onClick={() => navigate('find')}>
        First<span>Role</span>
      </button>
      <span className="footer-divider" />
      <span className="storage-note">
        {syncing ? (
          <>
            <LoaderCircle size={14} className="spin" />
            Saving changes…
          </>
        ) : signedIn ? (
          <>
            <Cloud size={14} />
            Your saved workspace syncs across devices
          </>
        ) : (
          <>
            <Monitor size={14} />
            Saved jobs stay in this browser
          </>
        )}
      </span>
      <div>
        <button onClick={() => setOverlay('how')}>Help</button>
        <span /> <button onClick={() => setOverlay('privacy')}>Privacy</button>
        <span />{' '}
        <a href="https://www.tinyfish.ai/" target="_blank" rel="noopener noreferrer">
          Powered by TinyFish
          <ExternalLink size={12} />
        </a>
      </div>
    </footer>
  );
}

interface ComparisonBarProps {
  comparedCount: number;
  onCompare: () => void;
  onClearComparison: () => void;
}
export function ComparisonBar({ comparedCount, onCompare, onClearComparison }: ComparisonBarProps) {
  return (
    <>
      {comparedCount > 0 && (
        <div className="compare-bar">
          <Layers3 size={21} />
          <strong>
            {comparedCount} {comparedCount === 1 ? 'job' : 'jobs'} selected
          </strong>
          <span>Choose up to three</span>
          <button className="button primary small" onClick={onCompare} disabled={comparedCount < 2}>
            Compare jobs
            <ArrowRight size={16} />
          </button>
          <button className="icon-button" aria-label="Clear comparison" onClick={onClearComparison}>
            <X size={19} />
          </button>
        </div>
      )}
    </>
  );
}

interface WorkspaceToastProps {
  toast: string | null;
  onDismissToast: () => void;
}
export function WorkspaceToast({ toast, onDismissToast }: WorkspaceToastProps) {
  return (
    <>
      {toast && (
        <div className="toast" role="status">
          <CheckCircle2 size={18} />
          {toast}
          <button
            className="icon-button"
            aria-label="Dismiss notification"
            onClick={onDismissToast}
          >
            <X size={15} />
          </button>
        </div>
      )}
    </>
  );
}
