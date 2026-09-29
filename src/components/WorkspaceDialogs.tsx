import {
  ArrowRight,
  ArrowUpRight,
  CheckCircle2,
  Download,
  ExternalLink,
  LogOut,
  ShieldCheck,
  Trash2,
  UserRound,
} from 'lucide-react';
import type { Job } from '../../shared/types';
import { typeLabels, workplaceLabels } from './Jobs';
import { Modal } from './Modal';
import type { WorkspaceOverlay, WorkspaceUser } from './AppChrome';

interface WorkspaceDialogsProps {
  overlay: WorkspaceOverlay;
  googleEnabled: boolean;
  syncing: boolean;
  user: WorkspaceUser | null;
  compareJobs: Job[];
  deleteText: string;
  deleting: boolean;
  setOverlay: (overlay: WorkspaceOverlay) => void;
  setDeleteText: (text: string) => void;
  setDeleting: (deleting: boolean) => void;
  setToast: (message: string | null) => void;
  signIn: () => Promise<boolean>;
  signOut: () => Promise<boolean>;
  exportData: () => boolean;
  deleteAccount: () => Promise<boolean>;
}

export function WorkspaceDialogs({
  overlay,
  googleEnabled,
  syncing,
  user,
  compareJobs,
  deleteText,
  deleting,
  setOverlay,
  setDeleteText,
  setDeleting,
  setToast,
  signIn,
  signOut,
  exportData,
  deleteAccount,
}: WorkspaceDialogsProps) {
  return (
    <>
      {overlay === 'signin' && (
        <Modal title="Keep your next steps with you." onClose={() => setOverlay(null)}>
          <p className="modal-lead">
            Sign in to bring your saved jobs, preferences, and application progress to any device.
          </p>
          <div className="signin-benefits">
            <p>
              <CheckCircle2 size={18} />
              One shortlist, wherever you are
            </p>
            <p>
              <CheckCircle2 size={18} />
              Pick up where you left off
            </p>
            <p>
              <CheckCircle2 size={18} />
              Import jobs saved in this browser
            </p>
          </div>
          <button
            className="button google-button"
            disabled={!googleEnabled || syncing}
            onClick={async () => {
              if (await signIn()) setOverlay(null);
            }}
          >
            <span className="google-g">G</span>Continue with Google
          </button>
          {!googleEnabled && (
            <p className="form-hint">
              Account sign-in is getting ready. You can still use your guest workspace.
            </p>
          )}
          <button className="text-button guest-continue" onClick={() => setOverlay(null)}>
            Continue as a guest
            <ArrowRight size={16} />
          </button>
          <p className="modal-fineprint">
            We only request your basic Google profile to identify your account. We do not access
            your email or files.
          </p>
        </Modal>
      )}
      {overlay === 'account' && (
        <Modal title="Your account" onClose={() => setOverlay(null)}>
          <div className="account-identity">
            <span className="account-avatar">
              <UserRound size={28} />
            </span>
            <div>
              <strong>{user?.name || 'FirstRole member'}</strong>
              <p>{user?.email}</p>
            </div>
          </div>
          <div className="account-options">
            <button onClick={() => exportData()}>
              <Download size={19} />
              <span>
                <strong>Export your workspace</strong>
                <small>Download your saved jobs and application notes.</small>
              </span>
              <ArrowUpRight size={17} />
            </button>
            <button
              onClick={async () => {
                if (await signOut()) {
                  setOverlay(null);
                  setToast('Signed out');
                }
              }}
            >
              <LogOut size={19} />
              <span>
                <strong>Sign out</strong>
                <small>Your account’s saved jobs will remain private.</small>
              </span>
            </button>
            <button
              className="danger-text"
              onClick={() => {
                setDeleteText('');
                setOverlay('delete');
              }}
            >
              <Trash2 size={19} />
              <span>
                <strong>Delete account and saved data</strong>
                <small>Permanently remove your FirstRole workspace.</small>
              </span>
            </button>
          </div>
        </Modal>
      )}
      {overlay === 'delete' && (
        <Modal title="Delete your FirstRole account?" onClose={() => setOverlay('account')}>
          <p className="modal-lead">
            This permanently removes your preferences, saved jobs, and application notes. It does
            not delete your Google account.
          </p>
          <label className="field">
            <span>Type DELETE to confirm</span>
            <input
              value={deleteText}
              onChange={(e) => setDeleteText(e.target.value)}
              autoComplete="off"
            />
          </label>
          <div className="modal-actions">
            <button className="button secondary" onClick={() => setOverlay('account')}>
              Keep account
            </button>
            <button
              className="button danger"
              disabled={deleteText !== 'DELETE' || deleting}
              onClick={async () => {
                setDeleting(true);
                if (await deleteAccount()) {
                  setOverlay(null);
                  setToast('Your account and saved data were deleted');
                }
                setDeleting(false);
              }}
            >
              {deleting ? 'Deleting…' : 'Delete account'}
            </button>
          </div>
        </Modal>
      )}
      {overlay === 'how' && (
        <Modal title="A clearer way to find your next role." onClose={() => setOverlay(null)}>
          <p className="modal-lead">
            FirstRole brings live opportunities into one useful workspace, with the evidence behind
            each match.
          </p>
          <ol className="how-steps">
            <li>
              <span>1</span>
              <div>
                <h3>Discover with TinyFish Search</h3>
                <p>Your role and location guide a search for relevant employers and job portals.</p>
              </div>
            </li>
            <li>
              <span>2</span>
              <div>
                <h3>Read with TinyFish Fetch</h3>
                <p>
                  We read the source pages, check details, and preserve the original application
                  links.
                </p>
              </div>
            </li>
            <li>
              <span>3</span>
              <div>
                <h3>Explore with TinyFish Agent</h3>
                <p>
                  When a careers page needs filters or navigation, Agent interacts with it to find
                  the relevant openings.
                </p>
              </div>
            </li>
            <li>
              <span>4</span>
              <div>
                <h3>Make an informed next step</h3>
                <p>
                  Compare the requirements, save useful opportunities, and apply directly with the
                  employer.
                </p>
              </div>
            </li>
          </ol>
          <div className="notice info">
            <ShieldCheck size={20} />
            <span>
              New searches use a limited shared pilot allowance. Recent results can be reused for
              six hours and always show when they were checked. FirstRole never submits applications
              for you.
            </span>
          </div>
        </Modal>
      )}
      {overlay === 'privacy' && (
        <Modal title="Your workspace, your data." onClose={() => setOverlay(null)}>
          <div className="privacy-copy">
            <h3>As a guest</h3>
            <p>
              Saved jobs, notes, and preferences stay in this browser. Clearing browser storage
              removes them.
            </p>
            <h3>With an account</h3>
            <p>
              Google supplies your basic sign-in identity. Supabase stores your preferences and
              saved workspace with access limited to your account. Export or delete your data from
              the account menu.
            </p>
            <h3>When you search</h3>
            <p>
              Your role, location, and search filters are sent to TinyFish to find relevant public
              listings. Personal application notes are not sent to TinyFish. FirstRole keeps
              short-lived search records and limited usage records to operate the pilot and prevent
              abuse.
            </p>
            <h3>When you apply</h3>
            <p>
              The employer’s site opens in a new tab. FirstRole does not submit your application,
              upload a résumé, or contact recruiters.
            </p>
          </div>
        </Modal>
      )}
      {overlay === 'compare' && (
        <Modal title="Find the differences that matter." onClose={() => setOverlay(null)} wide>
          <div className="comparison-scroll">
            <table className="comparison-table">
              <thead>
                <tr>
                  <th>Opportunity</th>
                  {compareJobs.map((job) => (
                    <th key={job.id}>
                      <span>{job.company}</span>
                      {job.title}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {[
                  ['Location', (j: Job) => j.location],
                  ['Work pattern', (j: Job) => workplaceLabels[j.workplace]],
                  ['Remote region', (j: Job) => j.remoteRegion || 'Not stated'],
                  ['Type', (j: Job) => typeLabels[j.employmentType]],
                  ['Salary', (j: Job) => j.salary?.text || 'Not listed'],
                  [
                    'Sponsorship',
                    (j: Job) =>
                      j.sponsorship === 'available'
                        ? 'Explicitly offered'
                        : j.sponsorship === 'unavailable'
                          ? 'Not available'
                          : 'Not stated',
                  ],
                  ['Match', (j: Job) => j.match.reasons.join(' · ') || 'Review requirements'],
                  ['Last checked', (j: Job) => new Date(j.checkedAt).toLocaleString()],
                ].map(([label, get]) => (
                  <tr key={label as string}>
                    <th scope="row">{label as string}</th>
                    {compareJobs.map((job) => (
                      <td key={job.id}>{(get as (j: Job) => string)(job)}</td>
                    ))}
                  </tr>
                ))}
                <tr>
                  <th>Next step</th>
                  {compareJobs.map((job) => (
                    <td key={job.id}>
                      <a
                        className="text-button"
                        href={job.applyUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        View opportunity
                        <ExternalLink size={14} />
                      </a>
                    </td>
                  ))}
                </tr>
              </tbody>
            </table>
          </div>
        </Modal>
      )}
    </>
  );
}
