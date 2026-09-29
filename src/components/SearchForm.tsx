import { useState } from 'react';
import {
  Search,
  MapPin,
  BriefcaseBusiness,
  Monitor,
  Building2,
  SlidersHorizontal,
  ChevronDown,
  X,
  ArrowRight,
} from 'lucide-react';
import type { SearchPreferences, JobType } from '../../shared/types';

interface Props {
  value: SearchPreferences;
  onChange: (v: SearchPreferences) => void;
  onSearch: () => void;
  busy: boolean;
}
export function SearchForm({ value, onChange, onSearch, busy }: Props) {
  const [expanded, setExpanded] = useState(false);
  const set = <K extends keyof SearchPreferences>(key: K, val: SearchPreferences[K]) =>
    onChange({ ...value, [key]: val });
  const jobSelection =
    value.jobTypes.length === 3
      ? 'all'
      : value.jobTypes.length === 2
        ? 'student'
        : value.jobTypes[0] || 'all';
  return (
    <form
      className="search-form"
      onSubmit={(e) => {
        e.preventDefault();
        onSearch();
      }}
    >
      <div className="search-fields">
        <label className="field">
          <span>Role or keywords</span>
          <div className="input-wrap">
            <Search size={21} />
            <input
              aria-label="Role or keywords"
              required
              minLength={2}
              maxLength={120}
              placeholder="e.g. Data analyst"
              value={value.role}
              onChange={(e) => set('role', e.target.value)}
              autoComplete="off"
            />
            {value.role && (
              <button
                type="button"
                className="icon-button clear-input"
                aria-label="Clear role"
                onClick={() => set('role', '')}
              >
                <X size={17} />
              </button>
            )}
          </div>
        </label>
        <label className="field">
          <span>Location</span>
          <div className="input-wrap">
            <MapPin size={21} />
            <input
              aria-label="Location"
              maxLength={100}
              placeholder="City, country, or worldwide"
              value={value.location}
              onChange={(e) => set('location', e.target.value)}
              autoComplete="off"
            />
            {value.location && (
              <button
                type="button"
                className="icon-button clear-input"
                aria-label="Clear location"
                onClick={() => set('location', '')}
              >
                <X size={17} />
              </button>
            )}
          </div>
        </label>
        <label className="field type-field">
          <span>Job type</span>
          <div className="input-wrap">
            <BriefcaseBusiness size={21} />
            <select
              value={jobSelection}
              onChange={(e) =>
                set(
                  'jobTypes',
                  e.target.value === 'all'
                    ? ['internship', 'graduate', 'entry-level']
                    : e.target.value === 'student'
                      ? ['internship', 'graduate']
                      : [e.target.value as JobType],
                )
              }
            >
              <option value="student">Internship + Graduate</option>
              <option value="internship">Internships</option>
              <option value="graduate">Graduate roles</option>
              <option value="entry-level">Entry-level roles</option>
              <option value="all">All early-career roles</option>
            </select>
            <ChevronDown className="select-chevron" size={17} />
          </div>
        </label>
        <button className="button primary search-button" type="submit" disabled={busy}>
          {busy ? 'Finding jobs…' : 'Find jobs'}
          {!busy && <ArrowRight className="mobile-search-arrow" size={19} />}
        </button>
      </div>
      <div className="filter-row">
        <div className="workplace-filters" aria-label="Work arrangement preferences">
          {(['remote', 'hybrid', 'onsite'] as const).map((mode, i) => {
            const Icon = i === 0 ? Monitor : Building2;
            return (
              <button
                key={mode}
                type="button"
                className={`filter-chip ${value.workplaces.includes(mode) ? 'active' : ''}`}
                aria-pressed={value.workplaces.includes(mode)}
                onClick={() =>
                  set(
                    'workplaces',
                    value.workplaces.includes(mode)
                      ? value.workplaces.filter((m) => m !== mode)
                      : [...value.workplaces, mode],
                  )
                }
              >
                <Icon size={18} />
                {['Remote', 'Hybrid', 'On-site'][i]}
              </button>
            );
          })}
        </div>
        <span className="filter-divider" />
        <button
          type="button"
          className={`filter-chip ${expanded ? 'active' : ''}`}
          aria-expanded={expanded}
          aria-controls="extra-filters"
          onClick={() => setExpanded(!expanded)}
        >
          <SlidersHorizontal size={18} />
          More filters
          {(value.keywords || value.sponsorshipRequired || value.postedWithinDays) && (
            <span className="filter-dot" />
          )}
          <ChevronDown size={16} className={expanded ? 'rotate' : ''} />
        </button>
      </div>
      {expanded && (
        <div className="extra-filters" id="extra-filters">
          <label className="field">
            <span>Skills to prioritize</span>
            <input
              maxLength={180}
              placeholder="e.g. SQL, Excel, research"
              value={value.keywords}
              onChange={(e) => set('keywords', e.target.value)}
            />
          </label>
          <label className="field">
            <span>Posted within</span>
            <select
              value={value.postedWithinDays || ''}
              onChange={(e) =>
                set('postedWithinDays', e.target.value ? Number(e.target.value) : null)
              }
            >
              <option value="">Any time</option>
              <option value="7">7 days</option>
              <option value="14">14 days</option>
              <option value="30">30 days</option>
            </select>
          </label>
          <label className="check-field">
            <input
              type="checkbox"
              checked={value.sponsorshipRequired}
              onChange={(e) => set('sponsorshipRequired', e.target.checked)}
            />
            <span>
              Only explicitly offered sponsorship
              <small>Listings that do not state it are excluded.</small>
            </span>
          </label>
        </div>
      )}
    </form>
  );
}
