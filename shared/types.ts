export type JobType = 'internship' | 'graduate' | 'entry-level';
export type Workplace = 'remote' | 'hybrid' | 'onsite' | 'unknown';
export type Sponsorship = 'available' | 'unavailable' | 'not-stated';
export type ApplicationStatus =
  'Saved' | 'Applied' | 'Interviewing' | 'Offer' | 'Rejected' | 'Withdrawn';

export interface SearchPreferences {
  role: string;
  location: string;
  jobTypes: JobType[];
  workplaces: Exclude<Workplace, 'unknown'>[];
  keywords: string;
  sponsorshipRequired: boolean;
  postedWithinDays: number | null;
}
export interface JobEvidence {
  field: string;
  text: string;
  sourceUrl: string;
}
export interface Job {
  id: string;
  title: string;
  company: string;
  location: string;
  workplace: Workplace;
  remoteRegion: string | null;
  employmentType: JobType | 'unknown';
  sourceUrl: string;
  applyUrl: string;
  requisitionId: string | null;
  description: string;
  requirements: string[];
  salary: { text: string; currency: string | null; period: string | null } | null;
  postedAt: string | null;
  deadline: string | null;
  checkedAt: string;
  sponsorship: Sponsorship;
  evidence: JobEvidence[];
  availability: 'open' | 'closed' | 'unverified';
  match: {
    tier: 'Strong match' | 'Good match' | 'Possible match';
    reasons: string[];
    score: number;
  };
}
export interface SavedJob {
  job: Job;
  status: ApplicationStatus;
  notes: string;
  appliedAt: string | null;
  savedAt: string;
  updatedAt: string;
}
export interface SourceProgress {
  url: string;
  name: string;
  status: 'pending' | 'reading' | 'extracting' | 'complete' | 'failed';
  count: number;
  message?: string;
}
export interface SearchRun {
  id: string;
  status:
    | 'queued'
    | 'discovering'
    | 'reading'
    | 'extracting'
    | 'verifying'
    | 'completed'
    | 'partial'
    | 'failed'
    | 'cancelled';
  stage: string;
  preferences: SearchPreferences;
  sources: SourceProgress[];
  results: Job[];
  errors: { source?: string; message: string }[];
  cached: boolean;
  createdAt: string;
  updatedAt: string;
}
export interface PublicConfig {
  supabaseUrl: string;
  supabasePublishableKey: string;
  searchEnabled: boolean;
  googleEnabled: boolean;
  setupMessage?: string;
}
/** Ephemeral response from the owned active-search preview endpoint; never part of SearchRun. */
export interface AgentPreview {
  status: 'waiting' | 'live' | 'unavailable' | 'ended';
  url?: string;
  sourceName?: string;
}
export const DEFAULT_PREFERENCES: SearchPreferences = {
  role: '',
  location: '',
  jobTypes: ['internship', 'graduate'],
  workplaces: [],
  keywords: '',
  sponsorshipRequired: false,
  postedWithinDays: null,
};
export const APPLICATION_STATUSES: ApplicationStatus[] = [
  'Saved',
  'Applied',
  'Interviewing',
  'Offer',
  'Rejected',
  'Withdrawn',
];
