import { useEffect, useRef, useState } from 'react';
import {
  Bookmark,
  Check,
  CheckCircle2,
  CircleHelp,
  ExternalLink,
  MapPin,
  ArrowLeft,
  RefreshCw,
  AlertCircle,
  ChevronRight,
  CircleMinus,
} from 'lucide-react';
import {
  APPLICATION_STATUSES,
  type Job,
  type SavedJob,
  type ApplicationStatus,
} from '../../shared/types';

export function timeAgo(date: string) {
  const minutes = Math.max(0, Math.floor((Date.now() - new Date(date).getTime()) / 60000));
  if (!Number.isFinite(minutes)) return 'Time unavailable';
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ago`;
  return new Date(date).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}
export const typeLabels = {
  internship: 'Internship',
  graduate: 'Graduate role',
  'entry-level': 'Entry level',
  unknown: 'Type not stated',
};
export const workplaceLabels = {
  remote: 'Remote',
  hybrid: 'Hybrid',
  onsite: 'On-site',
  unknown: 'Work pattern not stated',
};
export function CompanyMark({ company }: { company: string }) {
  const code = [...company].reduce((a, c) => a + c.charCodeAt(0), 0) % 4;
  return (
    <span className={`company-mark mark-${code}`} aria-hidden="true">
      {company.trim()[0]?.toUpperCase() || '?'}
    </span>
  );
}
function StateBadge({ job }: { job: Job }) {
  if (job.availability === 'closed') return <span className="match-badge closed">Closed</span>;
  if (job.availability === 'unverified')
    return <span className="match-badge neutral">Could not verify</span>;
  return (
    <span className={`match-badge ${job.match.tier === 'Possible match' ? 'neutral' : ''}`}>
      {job.match.tier}
    </span>
  );
}
export function JobRow({
  job,
  selected,
  saved,
  compared,
  onSelect,
  onSave,
  onCompare,
}: {
  job: Job;
  selected: boolean;
  saved: boolean;
  compared: boolean;
  onSelect: () => void;
  onSave: () => void;
  onCompare: () => void;
}) {
  return (
    <article className={`job-row ${selected ? 'selected' : ''}`}>
      <button
        className="job-select"
        onClick={onSelect}
        aria-label={`View ${job.title} at ${job.company}`}
        aria-pressed={selected}
      >
        <CompanyMark company={job.company} />
        <span className="job-heading">
          <span className="company-name">{job.company}</span>
          <span className="job-title">{job.title}</span>
          <span className="job-location">
            <MapPin size={17} />
            {job.location}
            {job.workplace !== 'unknown' ? ` · ${workplaceLabels[job.workplace]}` : ''}
          </span>
          <span className="job-type">{typeLabels[job.employmentType]}</span>
        </span>
      </button>
      <div className="job-match">
        <StateBadge job={job} />
        <ul>
          {job.match.reasons.slice(0, 2).map((reason) => (
            <li key={reason}>
              <CheckCircle2 size={16} />
              <span>{reason}</span>
            </li>
          ))}
          {job.match.reasons.length === 0 && (
            <li>
              <CircleHelp size={16} />
              <span>Review the requirements</span>
            </li>
          )}
        </ul>
        <span className="checked-time" title={new Date(job.checkedAt).toLocaleString()}>
          Checked {timeAgo(job.checkedAt).toLowerCase()}
        </span>
      </div>
      <div className="job-actions">
        <button
          className={`icon-button bookmark-button ${saved ? 'bookmarked' : ''}`}
          onClick={onSave}
          aria-label={`${saved ? 'Unsave' : 'Save'} ${job.title}`}
          aria-pressed={saved}
        >
          <Bookmark size={23} fill={saved ? 'currentColor' : 'none'} />
        </button>
        <label className="compare-toggle">
          <input type="checkbox" checked={compared} onChange={onCompare} />
          <span>Compare</span>
        </label>
        <ChevronRight className="row-mobile-chevron" size={20} />
      </div>
    </article>
  );
}
export function JobDetail({
  job,
  saved,
  onSave,
  onClose,
  onRefresh,
  refreshing,
}: {
  job: Job;
  saved: boolean;
  onSave: () => void;
  onClose: () => void;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  const sponsorText =
    job.sponsorship === 'available'
      ? 'Sponsorship explicitly offered'
      : job.sponsorship === 'unavailable'
        ? 'Sponsorship not available'
        : 'Sponsorship not stated';
  return (
    <aside className="detail-panel" aria-label="Job details">
      <button className="text-button mobile-back" onClick={onClose}>
        <ArrowLeft size={18} />
        Back to results
      </button>
      <div className="detail-heading">
        <CompanyMark company={job.company} />
        <div>
          <span className="company-name">{job.company}</span>
          <h2>{job.title}</h2>
          <p className="job-location">
            <MapPin size={17} />
            {job.location}
            {job.workplace !== 'unknown' ? ` · ${workplaceLabels[job.workplace]}` : ''}
          </p>
        </div>
      </div>
      <div className="detail-actions">
        {job.availability === 'closed' ? (
          <span className="button closed-action">Applications closed</span>
        ) : (
          <a
            className="button primary"
            href={job.applyUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            Apply on company site
            <ExternalLink size={18} />
          </a>
        )}
        <button className={`button secondary ${saved ? 'saved-action' : ''}`} onClick={onSave}>
          <Bookmark size={20} fill={saved ? 'currentColor' : 'none'} />
          {saved ? 'Saved' : 'Save'}
        </button>
      </div>
      {job.availability === 'unverified' && (
        <div className="notice warning">
          <AlertCircle size={19} />
          <span>
            We could not confirm this listing’s availability. Check the original page before
            applying.
          </span>
        </div>
      )}
      <section className="match-section">
        <h3>Why this fits</h3>
        <ul className="reason-list">
          {job.match.reasons.length ? (
            job.match.reasons.map((reason) => (
              <li key={reason}>
                <span className="reason-icon">
                  <Check size={14} />
                </span>
                <span>{reason}</span>
              </li>
            ))
          ) : (
            <li>
              <CircleHelp size={19} />
              <span>Read the requirements to check whether this opportunity fits.</span>
            </li>
          )}
        </ul>
        <div className={`sponsorship-note ${job.sponsorship === 'available' ? 'positive' : ''}`}>
          <AlertCircle size={20} />
          <div>
            <strong>{sponsorText}</strong>
            <span>
              {job.sponsorship === 'not-stated'
                ? 'The listing does not provide sponsorship information.'
                : 'Based on the employer’s published requirements.'}
            </span>
          </div>
        </div>
      </section>
      <section className="detail-section">
        <h3>At a glance</h3>
        <dl>
          <dt>Opportunity</dt>
          <dd>{typeLabels[job.employmentType]}</dd>
          <dt>Work pattern</dt>
          <dd>{workplaceLabels[job.workplace]}</dd>
          {job.remoteRegion && (
            <>
              <dt>Remote region</dt>
              <dd>{job.remoteRegion}</dd>
            </>
          )}
          <dt>Salary</dt>
          <dd>{job.salary?.text || 'Not listed'}</dd>
          <dt>Posted</dt>
          <dd>{job.postedAt ? new Date(job.postedAt).toLocaleDateString() : 'Not stated'}</dd>
          {job.deadline && (
            <>
              <dt>Apply by</dt>
              <dd>{new Date(job.deadline).toLocaleDateString()}</dd>
            </>
          )}
          <dt>Source</dt>
          <dd>{new URL(job.sourceUrl).hostname.replace(/^www\./, '')}</dd>
        </dl>
      </section>
      <section className="detail-section">
        <h3>About the role</h3>
        <p className="job-description">
          {job.description || 'Read the full description on the employer’s careers page.'}
        </p>
        {job.requirements.length > 0 && (
          <>
            <h4>What they’re looking for</h4>
            <ul className="requirements">
              {job.requirements.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
          </>
        )}
      </section>
      {job.evidence.length > 0 && (
        <details className="evidence-section">
          <summary>Details from the source</summary>
          {job.evidence.slice(0, 5).map((e, i) => (
            <blockquote key={i}>
              <span>{e.field}</span>
              {e.text}
              <a href={e.sourceUrl} target="_blank" rel="noopener noreferrer">
                View source <ExternalLink size={12} />
              </a>
            </blockquote>
          ))}
        </details>
      )}
      <footer className="detail-footer">
        <strong>Source & freshness</strong>
        <a href={job.sourceUrl} target="_blank" rel="noopener noreferrer">
          View original listing <ExternalLink size={13} />
        </a>
        <span title={new Date(job.checkedAt).toLocaleString()}>
          Checked {timeAgo(job.checkedAt).toLowerCase()}
        </span>
        <button className="text-button" onClick={onRefresh} disabled={refreshing}>
          <RefreshCw size={14} className={refreshing ? 'spin' : ''} />
          {refreshing ? 'Checking…' : 'Check again'}
        </button>
      </footer>
    </aside>
  );
}
export function ApplicationCard({
  entry,
  onUpdate,
  onView,
}: {
  entry: SavedJob;
  onUpdate: (patch: {
    status?: ApplicationStatus;
    notes?: string;
    appliedAt?: string | null;
  }) => Promise<boolean>;
  onView: () => void;
}) {
  const [notes, setNotes] = useState(entry.notes);
  const [saving, setSaving] = useState(false);
  const previousSavedNotes = useRef(entry.notes);
  useEffect(() => {
    const previous = previousSavedNotes.current;
    previousSavedNotes.current = entry.notes;
    // Remote changes update an untouched draft. A user who is still typing
    // keeps their text until they explicitly choose to save it.
    setNotes((draft) => (draft === previous ? entry.notes : draft));
  }, [entry.notes]);
  return (
    <article className="application-card">
      <div className="application-title">
        <CompanyMark company={entry.job.company} />
        <div>
          <span className="company-name">{entry.job.company}</span>
          <button className="text-button job-title" onClick={onView}>
            {entry.job.title}
          </button>
          <span className="muted">{entry.job.location}</span>
        </div>
      </div>
      <div className="application-fields">
        <label className="field">
          <span>Status</span>
          <select
            value={entry.status}
            onChange={(e) => void onUpdate({ status: e.target.value as ApplicationStatus })}
          >
            {APPLICATION_STATUSES.map((status) => (
              <option key={status}>{status}</option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Application date</span>
          <input
            type="date"
            value={entry.appliedAt?.slice(0, 10) || ''}
            onChange={(e) => void onUpdate({ appliedAt: e.target.value || null })}
          />
        </label>
      </div>
      <label className="field">
        <span>Your notes</span>
        <textarea
          rows={3}
          maxLength={4000}
          value={notes}
          placeholder="Who you spoke to, next steps, or a reminder…"
          onChange={(e) => setNotes(e.target.value)}
        />
      </label>
      <div className="application-footer">
        <span>
          <CircleMinus size={14} />
          Status is updated by you
        </span>
        <button
          className="button secondary small"
          disabled={saving || notes === entry.notes}
          onClick={async () => {
            setSaving(true);
            await onUpdate({ notes });
            setSaving(false);
          }}
        >
          {saving ? 'Saving…' : 'Save notes'}
        </button>
      </div>
    </article>
  );
}
