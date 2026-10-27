// Each tracked flight is an independent Tracker with its own fetch, state and
// refresh timer, so flights never affect one another.

const STORAGE_KEY = 'tracked-flights-v2';
const LEGACY_STORAGE_KEY = 'tracked-flights-v1';
const API_KEY_STORAGE = 'aerodatabox-key';
const MIN = 60 * 1000;
const DATE_OPTIONS = 10; // upcoming dates offered when no date is entered
const DATE_LOOKAHEAD_DAYS = 90;

const els = {
  form: document.getElementById('add-form'),
  number: document.getElementById('number'),
  date: document.getElementById('date'),
  submit: document.getElementById('submit'),
  msg: document.getElementById('form-msg'),
  picker: document.getElementById('date-picker'),
  list: document.getElementById('flights'),
  empty: document.getElementById('empty'),
  warning: document.getElementById('config-warning'),
  settings: document.getElementById('settings'),
  keyForm: document.getElementById('key-form'),
  keyInput: document.getElementById('api-key'),
  keyMsg: document.getElementById('key-msg'),
  exportBtn: document.getElementById('export'),
  importInput: document.getElementById('import'),
  stateMsg: document.getElementById('state-msg'),
};

const trackers = new Map(); // "NUMBER|DATE" -> Tracker

// ---------------------------------------------------------------------------
// Persistence: the tracked list plus each flight's last fetched data, so a
// reload shows flights straight away and only refetches what is due.
// ---------------------------------------------------------------------------

function storageGet(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function storageSet(key, value) {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* storage unavailable: tracking still works for this session */
  }
}

function parseSaved(v) {
  return Array.isArray(v)
    ? v.filter((f) => f && isFlightNumber(f.number) && isYmd(f.date))
    : [];
}

function loadSaved() {
  try {
    const raw = storageGet(STORAGE_KEY) ?? storageGet(LEGACY_STORAGE_KEY) ?? '[]';
    return parseSaved(JSON.parse(raw));
  } catch {
    return [];
  }
}

function snapshot() {
  // Map order is insertion order (oldest first), which is what addFlight expects on restore.
  return [...trackers.values()].map((t) => ({
    number: t.number,
    date: t.date,
    data: t.data,
    lastFetch: t.data ? t.lastFetch : 0,
  }));
}

function save() {
  storageSet(STORAGE_KEY, JSON.stringify(snapshot()));
}

function getApiKey() {
  return (storageGet(API_KEY_STORAGE) || '').trim();
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

  // Show previously saved data, then fetch only if a refresh is already due.
  restore(data, lastFetch) {
    this.data = data;
    this.lastFetch = lastFetch;
    const delay = this.nextDelay();
    if (delay == null) {
      this.render();
      return;
    }
    const remaining = lastFetch + delay - Date.now();
    if (remaining <= 0) return this.refresh();
    this.nextRefreshAt = Date.now() + remaining;
    this.timer = setTimeout(() => this.refreshIfVisible(), remaining);
    this.render();
  }

  async refresh() {
    clearTimeout(this.timer);
    this.loading = true;
    this.errorStatus = 0;
    this.render();
    try {
      const key = getApiKey();
      if (!key) throw httpError(401, 'Add your AeroDataBox API key in Settings to look up flights.');
      const legs = await fetchFlight(this.number, this.date, key);
      this.data = { number: this.number, date: this.date, provider: 'aerodatabox', fetchedAt: new Date().toISOString(), legs };
      this.error = null;
      this.errorStatus = 0;
    } catch (err) {
      this.errorStatus = err.status || 0;
      this.error = err.message || 'Network error';
    } finally {
      this.loading = false;
      this.lastFetch = Date.now();
      if (trackers.get(this.key) === this) {
        this.schedule();
        this.render();
        save();
      }
    }
  }

  // Refresh more often when the flight is active, stop once it is finished.
  schedule() {
    clearTimeout(this.timer);
    const delay = this.nextDelay();
    this.nextRefreshAt = delay == null ? 0 : Date.now() + delay;
    if (delay != null) this.timer = setTimeout(() => this.refreshIfVisible(), delay);
  }

  nextDelay() {
    if (this.error) {
      // Bad input / not found / missing key won't fix themselves; transient errors retry.
      if ([400, 401, 404].includes(this.errorStatus)) return null;
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

function addFlight(number, date, { persist = true, data = null, lastFetch = 0 } = {}) {
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
  if (data && lastFetch) t.restore(data, lastFetch);
  else t.refresh();
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

function removeAll() {
  for (const t of trackers.values()) t.destroy();
  trackers.clear();
}

function updateEmpty() {
  els.empty.hidden = trackers.size > 0;
}

function isFlightNumber(s) {
  return typeof s === 'string' && /^[A-Z0-9]{2,3}\d{1,4}[A-Z]?$/.test(s);
}

function isYmd(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function localYmd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function updateSubmitLabel() {
  els.submit.textContent = els.date.value ? 'Track flight' : 'Find dates';
}

els.date.addEventListener('input', updateSubmitLabel);

els.form.addEventListener('submit', (e) => {
  e.preventDefault();
  const number = els.number.value.toUpperCase().replace(/[\s-]+/g, '');
  const date = els.date.value;
  if (!isFlightNumber(number)) {
    els.msg.textContent = 'Enter an airline code followed by the flight number, e.g. UA123.';
    return;
  }
  if (!date) {
    showDatePicker(number);
    return;
  }
  closeDatePicker();
  els.msg.textContent = addFlight(number, date) ? '' : `${number} on ${date} is already being tracked.`;
  if (!els.msg.textContent) els.number.value = '';
  els.number.focus();
});

// ---------------------------------------------------------------------------
// Date picker: flight number only -> choose from its next operating dates
// ---------------------------------------------------------------------------

let pickerRequest = 0;

function closeDatePicker() {
  pickerRequest++;
  els.picker.hidden = true;
  els.picker.innerHTML = '';
}

async function showDatePicker(number) {
  const req = ++pickerRequest;
  els.msg.textContent = '';
  els.picker.hidden = false;
  els.picker.innerHTML = `<div class="loading">Finding upcoming dates for ${esc(number)}…</div>`;

  const key = getApiKey();
  if (!key) {
    els.picker.innerHTML = '<div class="error">Add your AeroDataBox API key in Settings first.</div>';
    els.settings.open = true;
    return;
  }

  const today = new Date();
  const to = new Date(today.getTime() + DATE_LOOKAHEAD_DAYS * 24 * 60 * MIN);
  let dates;
  try {
    // Start a day early: the flight's local date at origin can be behind the browser's date.
    const from = new Date(today.getTime() - 24 * 60 * MIN);
    dates = (await fetchFlightDates(number, localYmd(from), localYmd(to), key))
      .filter((d) => d >= localYmd(from))
      .slice(0, DATE_OPTIONS);
  } catch (err) {
    if (req !== pickerRequest) return;
    els.picker.innerHTML = `<div class="error">${esc(err.message || 'Could not load dates.')}</div>`;
    return;
  }
  if (req !== pickerRequest) return;

  els.picker.innerHTML = `
    <div class="picker-head">
      <strong>${esc(number)}</strong> operates on these dates. Pick one or more to track.
    </div>
    <div class="picker-dates">
      ${dates.map((d) => {
        const tracked = trackers.has(`${number}|${d}`);
        return `
          <label class="date-chip${tracked ? ' tracked' : ''}">
            <input type="checkbox" value="${d}" ${tracked ? 'checked disabled' : ''}>
            <span>${esc(formatDateOnly(d))}${tracked ? ' <small>tracking</small>' : ''}</span>
          </label>`;
      }).join('')}
    </div>
    <div class="picker-actions">
      <button type="button" data-pick="all">Select all</button>
      <button type="button" data-pick="track" class="primary">Track selected</button>
      <button type="button" data-pick="cancel">Cancel</button>
    </div>
  `;

  const boxes = () => [...els.picker.querySelectorAll('input[type=checkbox]:not(:disabled)')];
  const selectAllBtn = els.picker.querySelector('[data-pick=all]');
  const syncSelectAll = () => {
    const b = boxes();
    selectAllBtn.textContent = b.length && b.every((x) => x.checked) ? 'Clear' : 'Select all';
    selectAllBtn.disabled = b.length === 0;
  };
  syncSelectAll();

  els.picker.onchange = syncSelectAll;
  els.picker.onclick = (e) => {
    const action = e.target.closest('[data-pick]')?.dataset.pick;
    if (action === 'all') {
      const b = boxes();
      const check = !b.every((x) => x.checked);
      b.forEach((x) => (x.checked = check));
      syncSelectAll();
    } else if (action === 'cancel') {
      closeDatePicker();
    } else if (action === 'track') {
      const chosen = boxes().filter((x) => x.checked).map((x) => x.value);
      if (chosen.length === 0) {
        els.msg.textContent = 'Select at least one date.';
        return;
      }
      // Add latest first so the earliest date ends up at the top of the list.
      [...chosen].reverse().forEach((d) => addFlight(number, d));
      els.msg.textContent = `Tracking ${number} on ${chosen.length} date${chosen.length > 1 ? 's' : ''}.`;
      els.number.value = '';
      closeDatePicker();
    }
  };
}

// ---------------------------------------------------------------------------
// Settings: API key, export / import
// ---------------------------------------------------------------------------

function updateKeyWarning() {
  const has = Boolean(getApiKey());
  els.warning.hidden = has;
  if (!has) els.warning.textContent = 'Add your AeroDataBox API key in Settings below to start tracking.';
}

els.keyForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const key = els.keyInput.value.trim();
  storageSet(API_KEY_STORAGE, key || null);
  els.keyMsg.textContent = key ? 'Saved in this browser.' : 'Key removed.';
  updateKeyWarning();
  // Retry flights that failed only because the key was missing or wrong.
  if (key) for (const t of trackers.values()) if (t.errorStatus === 401) t.refresh();
});

els.exportBtn.addEventListener('click', () => {
  // The API key is deliberately left out of the file.
  const body = JSON.stringify({ app: 'flight-tracker', version: 2, exportedAt: new Date().toISOString(), flights: snapshot() }, null, 2);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([body], { type: 'application/json' }));
  a.download = `flights-${localYmd(new Date())}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  els.stateMsg.textContent = `Exported ${trackers.size} flight${trackers.size === 1 ? '' : 's'}.`;
});

els.importInput.addEventListener('change', async () => {
  const file = els.importInput.files[0];
  els.importInput.value = '';
  if (!file) return;
  let flights;
  try {
    const parsed = JSON.parse(await file.text());
    flights = parseSaved(Array.isArray(parsed) ? parsed : parsed.flights);
  } catch {
    els.stateMsg.textContent = 'That file is not a valid flight list.';
    return;
  }
  let added = 0;
  for (const f of flights) if (addFlight(f.number, f.date, { persist: false, data: f.data, lastFetch: f.lastFetch })) added++;
  save();
  updateEmpty();
  els.stateMsg.textContent = `Imported ${added} new flight${added === 1 ? '' : 's'}${flights.length > added ? ` (${flights.length - added} already tracked)` : ''}.`;
});

// Another tab changed the list: mirror it here.
window.addEventListener('storage', (e) => {
  if (e.key === API_KEY_STORAGE) updateKeyWarning();
  if (e.key !== STORAGE_KEY) return;
  removeAll();
  for (const f of loadSaved()) addFlight(f.number, f.date, { persist: false, data: f.data, lastFetch: f.lastFetch });
  updateEmpty();
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
  els.keyInput.value = getApiKey();
  updateKeyWarning();
  if (!getApiKey()) els.settings.open = true;
  updateSubmitLabel();

  // Saved list is oldest-first; prepending each one puts the newest on top again.
  for (const f of loadSaved()) addFlight(f.number, f.date, { persist: false, data: f.data, lastFetch: f.lastFetch });
  save(); // migrates a v1 list to the current format
  storageSet(LEGACY_STORAGE_KEY, null);
  updateEmpty();
})();
