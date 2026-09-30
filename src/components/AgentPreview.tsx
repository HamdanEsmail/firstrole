import { useEffect, useId, useState } from 'react';
import { ChevronDown, ChevronUp, Eye, Monitor, WifiOff } from 'lucide-react';
import { safeAgentPreviewUrl } from '../../shared/agent-preview';
import { observeAgentPreview, type PreviewDisplay } from '../lib/agent-preview';
import { sourceLabel } from '../lib/source-label';

interface AgentPreviewProps {
  searchId: string;
  accessToken: string | null;
  online: boolean;
}

export function AgentPreview({ searchId, accessToken, online }: AgentPreviewProps) {
  const [preview, setPreview] = useState<PreviewDisplay>({ status: 'checking' });
  useEffect(() => {
    if (!online) {
      setPreview({ status: 'offline' });
      return;
    }
    return observeAgentPreview(searchId, accessToken, setPreview);
  }, [searchId, accessToken, online]);
  return <AgentPreviewPanel preview={online ? preview : { status: 'offline' }} />;
}

export function AgentPreviewPanel({ preview }: { preview: PreviewDisplay }) {
  const [expanded, setExpanded] = useState(true);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const panelId = useId();
  const url = preview.status === 'live' ? safeAgentPreviewUrl(preview.url) : null;
  const status =
    preview.status === 'live' && (!url || failedUrl === url) ? 'unavailable' : preview.status;
  const sourceName =
    'sourceName' in preview && preview.sourceName ? sourceLabel(preview.sourceName) : null;
  const message = {
    checking: 'Checking for a browser preview…',
    waiting: 'Waiting for TinyFish to share its browser view.',
    live: 'Follow the browser while TinyFish checks this source.',
    unavailable: 'The browser preview is unavailable. Your search can continue without it.',
    ended: 'This browser session has ended. FirstRole is continuing with the results.',
    offline: 'Reconnect to see the browser preview. Your search can continue in the background.',
  }[status];

  return (
    <section className="agent-preview" aria-label="TinyFish Agent browser preview" aria-live="off">
      <div className="agent-preview-heading">
        <Monitor size={19} aria-hidden="true" />
        <div>
          <strong>TinyFish Agent</strong>
          {sourceName && <span>{sourceName}</span>}
        </div>
        <span className="agent-preview-view-only">
          <Eye size={14} aria-hidden="true" /> View only
        </span>
        <button
          className="text-button"
          aria-expanded={expanded}
          aria-controls={panelId}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? 'Hide preview' : 'Show preview'}
          {expanded ? (
            <ChevronUp size={16} aria-hidden="true" />
          ) : (
            <ChevronDown size={16} aria-hidden="true" />
          )}
        </button>
      </div>
      <div id={panelId} hidden={!expanded}>
        <p className="agent-preview-message" role="status">
          {message}
        </p>
        {expanded && status === 'live' && url ? (
          <>
            <div className="agent-preview-frame" inert aria-hidden="true">
              <iframe
                key={url}
                src={url}
                title="View-only TinyFish Agent browser"
                sandbox="allow-scripts allow-same-origin"
                referrerPolicy="no-referrer"
                tabIndex={-1}
                allow="camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'; payment 'none'"
                onError={() => setFailedUrl(url)}
              />
            </div>
            <p className="agent-preview-caption">
              This view does not accept clicks or typing. If it stays blank, the preview may not be
              available; your search can still continue.
            </p>
          </>
        ) : expanded ? (
          <div className="agent-preview-placeholder" aria-hidden="true">
            {status === 'offline' ? <WifiOff size={27} /> : <Monitor size={27} />}
            <span>
              {status === 'waiting' || status === 'checking'
                ? 'No browser view shared yet'
                : status === 'ended'
                  ? 'Browser session ended'
                  : 'Browser view unavailable'}
            </span>
          </div>
        ) : null}
      </div>
    </section>
  );
}
