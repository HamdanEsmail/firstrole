import {
  AlertCircle,
  ArrowRight,
  ArrowUpRight,
  Bookmark,
  BriefcaseBusiness,
  Check,
  CheckCircle2,
  Cloud,
  Download,
  Globe2,
  LoaderCircle,
  RefreshCw,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Square,
  WifiOff,
  X,
} from 'lucide-react';
import type { Job, PublicConfig, SavedJob, SearchPreferences, SearchRun } from '../../shared/types';
import { SearchForm } from './SearchForm';
import { ApplicationCard, JobDetail, JobRow, timeAgo } from './Jobs';
import type { WorkspaceUser, WorkspaceView } from './AppChrome';

export interface SearchPreset {
  role: string;
  location: string;
  label: string;
}
type SavedPatch = Partial<Pick<SavedJob, 'status' | 'notes' | 'appliedAt'>>;
interface ContentWorkspace {
  saved: SavedJob[];
  user: WorkspaceUser | null;
  error: string | null;
  guestImportCount: number;
  syncing: boolean;
  clearError: () => void;
  importGuest: () => Promise<boolean>;
  dismissImport: () => void;
  exportData: () => boolean;
  update: (jobId: string, patch: SavedPatch) => Promise<boolean>;
}
interface WorkspaceContentProps {
  view: WorkspaceView;
  workspace: ContentWorkspace;
  workspaceReady: boolean;
  config: PublicConfig | null;
  configError: boolean;
  online: boolean;
  error: string | null;
  mobileDetail: boolean;
  selectedJob: Job | undefined;
  preferences: SearchPreferences;
  active: boolean;
  starting: boolean;
  refreshing: boolean;
  run: SearchRun | null;
  terminalRun: boolean;
  jobs: Job[];
  tracked: SavedJob[];
  savedIds: ReadonlySet<string>;
  compared: string[];
  scope: string;
  sourceCount: number;
  savedFilter: string;
  applicationFilter: string;
  presets: SearchPreset[];
  navigate: (view: WorkspaceView) => void;
  setView: (view: WorkspaceView) => void;
  setSelected: (jobId: string | null) => void;
  setMobileDetail: (open: boolean) => void;
  setSavedFilter: (value: string) => void;
  setApplicationFilter: (value: string) => void;
  setError: (message: string | null) => void;
  setToast: (message: string | null) => void;
  setPreferences: (
    update: SearchPreferences | ((previous: SearchPreferences) => SearchPreferences),
  ) => void;
  search: (force?: boolean) => Promise<void>;
  stopSearch: () => Promise<void>;
  toggleSave: (job: Job) => Promise<void>;
  toggleCompare: (jobId: string) => void;
  recheck: (job: Job) => Promise<void>;
  choosePreset: (preset: SearchPreset) => void;
}

export function WorkspaceContent({
  view,
  workspace,
  workspaceReady,
  config,
  configError,
  online,
  error,
  mobileDetail,
  selectedJob,
  preferences,
  active,
  starting,
  refreshing,
  run,
  terminalRun,
  jobs,
  tracked,
  savedIds,
  compared,
  scope,
  sourceCount,
  savedFilter,
  applicationFilter,
  presets,
  navigate,
  setView,
  setSelected,
  setMobileDetail,
  setSavedFilter,
  setApplicationFilter,
  setError,
  setToast,
  setPreferences,
  search,
  stopSearch,
  toggleSave,
  toggleCompare,
  recheck,
  choosePreset,
}: WorkspaceContentProps) {
  return (
    <main
      id="main"
      className={`main-content ${mobileDetail && selectedJob ? 'show-mobile-detail' : ''}`}
    >
      <div className="page-intro">
        <div>
          <h1>
            {view === 'find'
              ? 'Find your next step.'
              : view === 'saved'
                ? 'Good opportunities, kept close.'
                : 'Every application. One clear view.'}
          </h1>
          <p>
            {view === 'find'
              ? 'Live opportunities, with the details that matter.'
              : view === 'saved'
                ? 'Your shortlist, ready when you are.'
                : 'Keep track of where you are and what comes next.'}
          </p>
        </div>
        {view !== 'find' && (
          <button className="button secondary" onClick={() => navigate('find')}>
            <Search size={18} />
            Find more jobs
          </button>
        )}
      </div>
      {!workspaceReady && !configError && (
        <div className="notice info" role="status">
          <LoaderCircle size={20} className="spin" />
          <span>Loading your workspace…</span>
        </div>
      )}
      {!online && (
        <div className="notice warning" role="status">
          <WifiOff size={20} />
          <span>
            You’re offline. Your saved jobs are still here. Reconnect to search or sync changes.
          </span>
        </div>
      )}
      {(error || workspace.error) && (
        <div className="notice error" role="alert">
          <AlertCircle size={20} />
          <span>{error || workspace.error}</span>
          <button
            className="icon-button"
            aria-label="Dismiss message"
            onClick={() => {
              setError(null);
              workspace.clearError();
            }}
          >
            <X size={18} />
          </button>
        </div>
      )}
      {workspace.guestImportCount > 0 && workspace.user && (
        <div className="import-banner">
          <Cloud size={21} />
          <div>
            <strong>Bring your saved jobs with you</strong>
            <p>
              {workspace.guestImportCount}{' '}
              {workspace.guestImportCount === 1 ? 'job is' : 'jobs are'} saved in this browser. Add
              them to your account.
            </p>
          </div>
          <button
            className="button primary small"
            disabled={workspace.syncing}
            onClick={async () => {
              if (await workspace.importGuest()) setToast('Guest jobs added to your account');
            }}
          >
            Import jobs
          </button>
          <button className="text-button" onClick={workspace.dismissImport}>
            Later
          </button>
        </div>
      )}
      {view === 'find' && (
        <SearchForm
          value={preferences}
          onChange={setPreferences}
          onSearch={() => void search()}
          busy={active || !workspaceReady}
        />
      )}
      {view === 'saved' && workspace.saved.length > 0 && (
        <div className="saved-toolbar">
          <label className="input-wrap">
            <Search size={19} />
            <input
              aria-label="Search saved jobs"
              placeholder="Find a saved role or company"
              value={savedFilter}
              onChange={(e) => setSavedFilter(e.target.value)}
            />
          </label>
          <span className="muted">
            {jobs.length} saved {jobs.length === 1 ? 'opportunity' : 'opportunities'}
          </span>
          <button className="text-button" onClick={() => workspace.exportData()}>
            <Download size={16} />
            Export
          </button>
        </div>
      )}
      {view === 'find' && active && (
        <section className="search-progress" aria-live="polite">
          <div className="progress-title">
            <LoaderCircle size={20} className="spin" />
            <div>
              <strong>
                {starting
                  ? 'Starting your search…'
                  : run?.stage || 'Finding relevant opportunities…'}
              </strong>
              <span>Reading the live web. You can leave this page and come back.</span>
            </div>
            {run && !starting && (
              <button className="text-button" onClick={() => void stopSearch()}>
                <Square size={13} />
                Stop search
              </button>
            )}
          </div>
          {run && !starting && run.sources.length > 0 && (
            <div className="source-progress">
              {run.sources.map((source) => (
                <span
                  key={source.url}
                  className={source.status === 'failed' ? 'source-failed' : ''}
                >
                  {source.status === 'complete' ? (
                    <Check size={14} />
                  ) : source.status === 'failed' ? (
                    <AlertCircle size={14} />
                  ) : (
                    <LoaderCircle className="spin" size={14} />
                  )}{' '}
                  {source.name}
                  <small>
                    {source.status === 'complete' ? `${source.count} found` : source.status}
                  </small>
                </span>
              ))}
            </div>
          )}
        </section>
      )}
      {view === 'find' && run && !starting && terminalRun && run.errors.length > 0 && (
        <div className="coverage-note">
          <AlertCircle size={17} />
          <div>
            <strong>
              {run.results.length
                ? 'Some sources could not be checked'
                : 'Search coverage was limited'}
            </strong>
            <p>
              {run.errors
                .map((e) => e.message)
                .filter((v, i, a) => a.indexOf(v) === i)
                .join(' ')}
            </p>
          </div>
        </div>
      )}
      {view === 'find' && !starting && run?.status === 'cancelled' && (
        <div className="notice info" role="status">
          <Square size={18} />
          <span>
            <strong>Search stopped.</strong> Any results already found are still available. Your
            saved jobs are kept.
          </span>
        </div>
      )}
      {view === 'find' &&
        run &&
        !starting &&
        ['completed', 'partial', 'failed'].includes(run.status) && (
          <details className="source-coverage" key={run.id}>
            <summary>
              Sources checked
              <span className="source-coverage-count">
                {run.sources.length} {run.sources.length === 1 ? 'source' : 'sources'}
              </span>
            </summary>
            <div className="source-coverage-content">
              <p>
                {run.results.length === 0
                  ? 'No verified matches were returned from this search. The source statuses below show what could be checked.'
                  : 'These are the sources considered for this search, including any checks that could not finish.'}
                {run.cached ? ' This coverage comes from the previous search.' : ''}
              </p>
              {run.sources.length > 0 ? (
                <>
                  <ul className="source-coverage-list">
                    {run.sources.map((source) => (
                      <li key={source.url}>
                        <div className="source-coverage-row">
                          <a href={source.url} target="_blank" rel="noopener noreferrer">
                            {source.name}
                            <ArrowUpRight size={13} aria-hidden="true" />
                          </a>
                          <span className={`source-coverage-status ${source.status}`}>
                            {
                              {
                                pending: 'Not checked',
                                reading: 'Reading incomplete',
                                extracting: 'Interaction incomplete',
                                complete: 'Checked',
                                failed: 'Could not check',
                              }[source.status]
                            }
                          </span>
                          <span className="source-coverage-found">
                            {source.count} {source.count === 1 ? 'listing' : 'listings'} recorded
                          </span>
                        </div>
                        {source.message && <p>{source.message}</p>}
                      </li>
                    ))}
                  </ul>
                  <p className="source-coverage-explanation">
                    The final shortlist reflects your filters and availability checks. Broaden the
                    search or visit the source pages to explore other openings.
                  </p>
                </>
              ) : (
                <p>No careers pages could be checked. Try again or adjust the role and location.</p>
              )}
            </div>
          </details>
        )}
      {view === 'applications' ? (
        <>
          {workspace.saved.length > 0 ? (
            <>
              <div className="application-tabs" aria-label="Filter applications">
                {['All', 'Saved', 'Applied', 'Interviewing', 'Offer', 'Rejected', 'Withdrawn'].map(
                  (status) => (
                    <button
                      key={status}
                      className={applicationFilter === status ? 'active' : ''}
                      onClick={() => setApplicationFilter(status)}
                    >
                      {status}
                      <span>
                        {status === 'All'
                          ? workspace.saved.length
                          : workspace.saved.filter((s) => s.status === status).length}
                      </span>
                    </button>
                  ),
                )}
              </div>
              <div className="application-grid">
                {tracked.map((entry) => (
                  <ApplicationCard
                    key={`${scope}:${entry.job.id}`}
                    entry={entry}
                    onUpdate={(patch) => workspace.update(entry.job.id, patch)}
                    onView={() => {
                      navigate('saved');
                      setSelected(entry.job.id);
                      setMobileDetail(true);
                    }}
                  />
                ))}
              </div>
              {tracked.length === 0 && (
                <div className="compact-empty">No applications at this stage yet.</div>
              )}
            </>
          ) : (
            <EmptyWorkspace icon="applications" onSearch={() => navigate('find')} />
          )}
        </>
      ) : jobs.length > 0 ? (
        <div className="results-layout">
          <div className="results-column">
            <div className="results-toolbar">
              <div>
                <strong>
                  {jobs.length}{' '}
                  {view === 'saved' ? 'saved' : jobs.length === 1 ? 'match' : 'matches'}
                </strong>
                {view === 'find' && run && (
                  <>
                    <span className="toolbar-separator" />
                    from {sourceCount} {sourceCount === 1 ? 'source' : 'sources'}
                    <span className="toolbar-separator" />
                    <span className="checked-label">
                      {run.cached ? 'Previous search · ' : ''}Checked{' '}
                      {timeAgo(run.updatedAt).toLowerCase()}
                    </span>
                  </>
                )}
              </div>
              {view === 'find' && (
                <button
                  className="text-button refresh-results"
                  disabled={active}
                  onClick={() => void search(true)}
                >
                  <RefreshCw size={17} />
                  Refresh results
                </button>
              )}
            </div>
            <div className="job-list">
              {jobs.map((job) => (
                <JobRow
                  key={job.id}
                  job={job}
                  selected={selectedJob?.id === job.id}
                  saved={savedIds.has(job.id)}
                  compared={compared.includes(job.id)}
                  onSelect={() => {
                    setSelected(job.id);
                    setMobileDetail(true);
                  }}
                  onSave={() => void toggleSave(job)}
                  onCompare={() => toggleCompare(job.id)}
                />
              ))}
            </div>
            <p className="results-footnote">
              <ShieldCheck size={14} />
              Matches are based on the listing. Always check the employer’s full requirements.
            </p>
          </div>
          {selectedJob && (
            <JobDetail
              job={selectedJob}
              saved={savedIds.has(selectedJob.id)}
              onSave={() => void toggleSave(selectedJob)}
              onClose={() => setMobileDetail(false)}
              onRefresh={() => void recheck(selectedJob)}
              refreshing={refreshing}
            />
          )}
        </div>
      ) : view === 'saved' ? (
        <EmptyWorkspace icon="saved" onSearch={() => navigate('find')} />
      ) : (
        <div className="initial-layout">
          <section className="search-empty">
            <div className="empty-symbol">
              <Search size={32} strokeWidth={1.5} />
            </div>
            <h2>
              {active
                ? 'Looking for your next opportunity.'
                : run?.status === 'cancelled'
                  ? 'Ready when you are.'
                  : run
                    ? 'A good match takes the right search.'
                    : 'Your next step starts here.'}
            </h2>
            <p>
              {active
                ? 'We’re finding careers pages and checking the details. Results will appear here as they’re verified.'
                : run?.status === 'cancelled'
                  ? 'This search stopped before matching jobs were returned. Start another search whenever you’re ready.'
                  : run
                    ? 'Try a broader role, a nearby city, or fewer filters. Live availability changes, and we won’t fill the gaps with invented jobs.'
                    : 'Choose a role and location. We’ll check the live web for opportunities worth a closer look.'}
            </p>
            {!run && !active && (
              <>
                <span className="suggestion-label">A few places to start</span>
                <div className="search-suggestions">
                  {presets.map((preset) => (
                    <button key={preset.role} onClick={() => choosePreset(preset)}>
                      {preset.label}
                      <ArrowUpRight size={16} />
                    </button>
                  ))}
                </div>
              </>
            )}
            {run && !active && run.status !== 'cancelled' && (
              <button
                className="button secondary"
                onClick={() => {
                  setPreferences((p) => ({
                    ...p,
                    workplaces: [],
                    sponsorshipRequired: false,
                    postedWithinDays: null,
                  }));
                  setToast('Extra filters cleared. Try your search again.');
                }}
              >
                <SlidersHorizontal size={17} />
                Clear extra filters
              </button>
            )}
            {active && (
              <div className="loading-bars" aria-hidden="true">
                <span />
                <span />
                <span />
              </div>
            )}
          </section>
          <aside className="expect-panel">
            <h3>A little clarity goes a long way.</h3>
            <div>
              <Globe2 size={21} />
              <section>
                <h4>Opportunities from the source</h4>
                <p>Company careers pages and job portals, checked when you search.</p>
              </section>
            </div>
            <div>
              <CheckCircle2 size={21} />
              <section>
                <h4>Understand the match</h4>
                <p>See what fits, what’s required, and what the employer hasn’t stated.</p>
              </section>
            </div>
            <div>
              <Bookmark size={21} />
              <section>
                <h4>Keep your next steps together</h4>
                <p>Save a shortlist, compare roles, and follow each application.</p>
              </section>
            </div>
            <div className="expect-note">
              <ShieldCheck size={17} />
              <span>Powered by TinyFish. Real sources, clear provenance.</span>
            </div>
            {(configError || (config && !config.searchEnabled)) && (
              <p className="availability-note">
                Live search is getting ready. Your saved workspace is available now.
              </p>
            )}
          </aside>
        </div>
      )}
    </main>
  );
}

function EmptyWorkspace({
  icon,
  onSearch,
}: {
  icon: 'saved' | 'applications';
  onSearch: () => void;
}) {
  const Icon = icon === 'saved' ? Bookmark : BriefcaseBusiness;
  return (
    <section className="workspace-empty">
      <div className="empty-symbol">
        <Icon size={34} strokeWidth={1.5} />
      </div>
      <h2>
        {icon === 'saved'
          ? 'Make room for the right opportunities.'
          : 'Your next chapter is taking shape.'}
      </h2>
      <p>
        {icon === 'saved'
          ? 'Save a job that catches your eye. Your shortlist will be here when you’re ready to take the next step.'
          : 'Save an opportunity first, then update its status as you apply, interview, and hear back.'}
      </p>
      <button className="button primary" onClick={onSearch}>
        Find opportunities
        <ArrowRight size={18} />
      </button>
    </section>
  );
}
