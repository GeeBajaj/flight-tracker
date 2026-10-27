// Each tracked flight is an independent Tracker with its own fetch, state and
// refresh timer, so flights never affect one another.

const STORAGE_KEY = 'tracked-flights-v1';
const MIN = 60 * 1000;

const els = {
  form: document.getElementById('add-form'),
  number: document.getElementById('number'),
  date: document.getElementById('date'),
  msg: document.getElementById('form-msg'),
  list: document.getElementById('flights'),
  empty: document.getElementById('empty'),
  warning: document.getElementById('config-warning'),
};

const trackers = new Map(); // "NUMBER|DATE" -> Tracker

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function loadSaved() {
  try {
    const v = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    return Array.isArray(v) ? v.filter((f) => f && f.number && f.date) : [];
  } catch {
    return [];
  }
}

function save() {
  try {
    const list = [...trackers.values()].map((t) => ({ number: t.number, date: t.date }));
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch {
    /* storage unavailable: tracking still works for this session */
  }
}

// ---------------------------------------------------------------------------
// Tracker
// ---------------------------------------------------------------------------

class Tracker {
  constructor(number, date) {
    this.number = number;
    this.date = date;
    this.key = `${number}|${date}`;
    this.data = null;
    this.error = null;
    this.errorStatus = 0;
    this.loading = false;
    this.timer = null;
    this.lastFetch = 0;
    this.nextRefreshAt = 0;

    this.el = document.createElement('article');
    this.el.className = 'card';
    this.el.addEventListener('click', (e) => {
      const action = e.target.closest('[data-action]')?.dataset.action;
      if (action === 'refresh') this.refresh();
      if (action === 'remove') removeFlight(this.key);
    });
  }

  async refresh() {
    clearTimeout(this.timer);
    this.loading = true;
    this.errorStatus = 0;
    this.render();
    try {
      const r = await fetch(`/api/flight?number=${encodeURIComponent(this.number)}&date=${this.date}`);
      const body = await r.json().catch(() => ({}));
      if (!r.ok) {
        this.errorStatus = r.status;
        throw new Error(body.error || `Request failed (${r.status})`);
      }
      this.data = body;
      this.error = null;
      this.errorStatus = 0;
    } catch (err) {
      this.error = err.message || 'Network error';
    } finally {
      this.loading = false;
      this.lastFetch = Date.now();
      if (trackers.get(this.key) === this) {
        this.schedule();
        this.render();
      }
    }
  }

  // Refresh more often when the flight is active, stop once it is finished.
  schedule() {
    const delay = this.nextDelay();
    this.nextRefreshAt = delay == null ? 0 : Date.now() + delay;
    if (delay != null) this.timer = setTimeout(() => this.refreshIfVisible(), delay);
  }

  nextDelay() {
    if (this.error) {
      // Bad input / not found won't fix itself; transient errors retry.
      if (this.errorStatus === 400 || this.errorStatus === 404) return null;
      return this.errorStatus === 429 ? 10 * MIN : 3 * MIN;
    }
    const legs = this.data?.legs || [];
    if (legs.length && legs.every((l) => l.status === 'arrived' || l.status === 'cancelled')) return null;

    if (legs.some((l) => ['boarding', 'departed', 'enroute', 'landed', 'diverted'].includes(l.status))) return 2 * MIN;
    const nextDep = Math.min(
      ...legs.map((l) => Date.parse(l.departure.estimated || l.departure.scheduled)).filter(Number.isFinite),
    );
    const until = nextDep - Date.now();
    if (!Number.isFinite(until)) return 15 * MIN;
    if (until < 3 * 60 * MIN) return 3 * MIN;
    if (until < 24 * 60 * MIN) return 15 * MIN;
    return 60 * MIN;
  }

  refreshIfVisible() {
    if (document.hidden) this.staleWhileHidden = true;
    else this.refresh();
  }

  destroy() {
    clearTimeout(this.timer);
    this.el.remove();
  }

  render() {
    const d = this.data;
    const first = d?.legs?.[0];
    const airline = first?.airline?.name ? `${esc(first.airline.name)} · ` : '';
    const updated = this.lastFetch ? `Updated ${relTime(this.lastFetch)}` : '';
    const next = this.nextRefreshAt ? ` · next check ${relTime(this.nextRefreshAt)}` : this.lastFetch ? ' · auto-refresh stopped' : '';

    this.el.innerHTML = `
      <div class="card-head">
        <div>
          <div class="card-title">${esc(this.number)}</div>
          <div class="card-sub">${airline}Departs ${esc(formatDateOnly(this.date))}</div>
          <div class="card-sub">${updated}${next}</div>
        </div>
        <div class="card-actions">
          <button data-action="refresh" ${this.loading ? 'disabled' : ''}>${this.loading ? 'Refreshing…' : 'Refresh'}</button>
          <button data-action="remove" aria-label="Stop tracking ${esc(this.number)}">Remove</button>
        </div>
      </div>
      ${this.error ? `<div class="error">${esc(this.error)}${d ? ' Showing last known data.' : ''}</div>` : ''}
      ${!d && this.loading ? '<div class="loading">Looking up flight…</div>' : ''}
      ${d ? d.legs.map(renderLeg).join('') : ''}
    `;
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const STATUS_LABEL = {
  scheduled: 'Scheduled', boarding: 'Boarding', departed: 'Departed', enroute: 'En route', landed: 'Landed',
  arrived: 'Arrived', delayed: 'Delayed', cancelled: 'Cancelled', diverted: 'Diverted', unknown: 'Unknown',
};

function renderLeg(leg) {
  const dep = leg.departure;
  const arr = leg.arrival;
  const progress = legProgress(leg);
  const facts = [
    leg.aircraft?.model && `Aircraft: ${esc(leg.aircraft.model)}`,
    leg.aircraft?.reg && `Reg: ${esc(leg.aircraft.reg)}`,
    leg.distanceKm && `${leg.distanceKm.toLocaleString()} km`,
    leg.position?.altFt != null && `Altitude: ${Math.round(leg.position.altFt).toLocaleString()} ft`,
    leg.position?.speedKt != null && `Ground speed: ${Math.round(leg.position.speedKt)} kt`,
    leg.lastUpdated && `Provider updated ${relTime(Date.parse(leg.lastUpdated))}`,
  ].filter(Boolean);

  let midText = '';
  if (leg.status === 'cancelled') midText = 'Cancelled';
  else if (progress != null && progress > 0 && progress < 100) {
    const eta = Date.parse(arr.estimated || arr.scheduled) - Date.now();
    midText = eta > 0 ? `${durationText(eta)} remaining` : 'Arriving';
  } else if (progress == null || progress === 0) {
    const dur = Date.parse(arr.scheduled) - Date.parse(dep.scheduled);
    if (dur > 0) midText = `${durationText(dur)} flight`;
  }

  return `
    <div class="leg">
      <div class="leg-head">
        <span class="badge s-${leg.status}">${STATUS_LABEL[leg.status] || esc(leg.status)}</span>
        ${leg.statusText && leg.statusText.toLowerCase() !== (STATUS_LABEL[leg.status] || '').toLowerCase()
          ? `<span class="status-text">${esc(leg.statusText)}</span>` : ''}
        ${leg.isCodeshare ? '<span class="status-text">Codeshare</span>' : ''}
      </div>
      <div class="route">
        ${renderEnd(dep, 'dep', leg)}
        <div class="mid">
          <div class="bar">
            <div class="bar-fill" style="width:${progress ?? 0}%"></div>
            ${leg.status !== 'cancelled' ? `<span class="plane" style="left:${progress ?? 0}%">✈</span>` : ''}
          </div>
          <div class="mid-text">${midText}</div>
        </div>
        ${renderEnd(arr, 'arr', leg)}
      </div>
      ${facts.length ? `<div class="extra">${facts.map((f) => `<span>${f}</span>`).join('')}</div>` : ''}
    </div>
  `;
}

function renderEnd(e, kind, leg) {
  const best = e.actual || e.estimated || e.scheduled;
  const label = e.actual ? (kind === 'dep' ? 'Departed' : 'Arrived') : e.estimated ? 'Estimated' : 'Scheduled';
  const changed = best && e.scheduled && Math.abs(Date.parse(best) - Date.parse(e.scheduled)) >= MIN;
  const facts = [
    e.terminal && `Terminal <b>${esc(e.terminal)}</b>`,
    e.gate && `Gate <b>${esc(e.gate)}</b>`,
    e.baggage && `Baggage <b>${esc(e.baggage)}</b>`,
  ].filter(Boolean);

  return `
    <div class="end ${kind}">
      <div class="code">${esc(e.iata || e.icao || '—')}</div>
      <div class="apt">${esc([e.city, e.name].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(' · '))}</div>
      <div class="time">${best ? fmtTime(best, e.tz) : '—'} <small>${label}</small></div>
      ${changed ? `<div class="sched">Scheduled <s>${fmtTime(e.scheduled, e.tz)}</s></div>` : ''}
      ${leg.status !== 'cancelled' ? delayHtml(e) : ''}
      ${facts.length ? `<div class="facts">${facts.join(' · ')}</div>` : ''}
    </div>
  `;
}

function delayHtml(e) {
  const best = e.actual || e.estimated;
  if (!best || !e.scheduled) return '';
  const mins = Math.round((Date.parse(best) - Date.parse(e.scheduled)) / MIN);
  if (mins >= 1) return `<div class="delay ${mins >= 30 ? 'very-late' : 'late'}">${durationText(mins * MIN)} late</div>`;
  if (mins <= -1) return `<div class="delay early">${durationText(-mins * MIN)} early</div>`;
  return '<div class="delay ontime">On time</div>';
}

// Percentage of the flight completed, based on actual/estimated times.
function legProgress(leg) {
  if (leg.status === 'cancelled') return null;
  if (leg.status === 'arrived' || leg.status === 'landed' || leg.arrival.actual) return 100;
  if (typeof leg.progress === 'number') return clamp(leg.progress, 0, 100);
  const start = Date.parse(leg.departure.actual || '');
  const end = Date.parse(leg.arrival.estimated || leg.arrival.scheduled || '');
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 0;
  return clamp(((Date.now() - start) / (end - start)) * 100, 1, 99);
}

// ---------------------------------------------------------------------------
// Formatting (times are shown in each airport's own time zone)
// ---------------------------------------------------------------------------

function fmtTime(iso, tz) {
  const d = new Date(iso);
  const opts = { hour: '2-digit', minute: '2-digit', timeZone: tz || undefined };
  try {
    const time = new Intl.DateTimeFormat(undefined, opts).format(d);
    const day = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short', timeZone: tz || undefined }).format(d);
    const zone = new Intl.DateTimeFormat('en-US', { timeZoneName: 'short', timeZone: tz || undefined })
      .formatToParts(d).find((p) => p.type === 'timeZoneName')?.value || '';
    return `${time} <small>${esc(zone)} · ${esc(day)}</small>`;
  } catch {
    return esc(d.toUTCString());
  }
}

function formatDateOnly(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(undefined, {
    weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
  });
}

function durationText(ms) {
  const total = Math.round(ms / MIN);
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
}

function relTime(t) {
  const diff = t - Date.now();
  const mins = Math.round(Math.abs(diff) / MIN);
  if (mins < 1) return diff > 0 ? 'in under a minute' : 'just now';
  const text = mins < 60 ? `${mins} min` : durationText(mins * MIN);
  return diff > 0 ? `in ${text}` : `${text} ago`;
}

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// ---------------------------------------------------------------------------
// Add / remove
// ---------------------------------------------------------------------------

function addFlight(number, date, { persist = true } = {}) {
  const key = `${number}|${date}`;
  if (trackers.has(key)) {
    const el = trackers.get(key).el;
    el.classList.remove('flash');
    void el.offsetWidth;
    el.classList.add('flash');
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return false;
  }
  const t = new Tracker(number, date);
  trackers.set(key, t);
  els.list.prepend(t.el);
  t.refresh();
  if (persist) save();
  updateEmpty();
  return true;
}

function removeFlight(key) {
  const t = trackers.get(key);
  if (!t) return;
  t.destroy();
  trackers.delete(key);
  save();
  updateEmpty();
}

function updateEmpty() {
  els.empty.hidden = trackers.size > 0;
}

els.form.addEventListener('submit', (e) => {
  e.preventDefault();
  const number = els.number.value.toUpperCase().replace(/[\s-]+/g, '');
  const date = els.date.value;
  if (!/^[A-Z0-9]{2,3}\d{1,4}[A-Z]?$/.test(number)) {
    els.msg.textContent = 'Enter an airline code followed by the flight number, e.g. UA123.';
    return;
  }
  if (!date) {
    els.msg.textContent = 'Pick the local departure date.';
    return;
  }
  els.msg.textContent = addFlight(number, date) ? '' : `${number} on ${date} is already being tracked.`;
  if (!els.msg.textContent) els.number.value = '';
  els.number.focus();
});

// Catch up on refreshes skipped while the tab was hidden.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  for (const t of trackers.values()) {
    if (t.staleWhileHidden) {
      t.staleWhileHidden = false;
      t.refresh();
    }
  }
});

// Keep "updated x min ago" labels and progress bars current between fetches.
setInterval(() => {
  for (const t of trackers.values()) if (!t.loading) t.render();
}, 30 * 1000);

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

(function init() {
  const now = new Date();
  els.date.value = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

  // Saved list is oldest-first; prepending each one puts the newest on top again.
  for (const f of loadSaved()) addFlight(f.number, f.date, { persist: false });
  updateEmpty();

  fetch('/api/health').then((r) => r.json()).then((h) => {
    if (!h.configured) {
      els.warning.hidden = false;
      els.warning.textContent = 'No flight data API key is configured on the server. See README.md to add one.';
    }
  }).catch(() => {});
})();
