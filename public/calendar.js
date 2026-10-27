// Month-view date picker for one flight number. Only dates the flight operates on
// can be selected; every other day is shown greyed out. Dates are YYYY-MM-DD strings.

class FlightCalendar {
  // valid: Set of operating dates. tracked: Set of dates already being tracked.
  // min / max: the range the valid set covers (days outside it are unknown, not invalid).
  constructor(container, { valid, tracked, min, max, today, start, onChange }) {
    this.el = container;
    this.valid = valid;
    this.tracked = tracked;
    this.min = min;
    this.max = max;
    this.today = today;
    this.onChange = onChange || (() => {});
    this.selected = new Set();
    this.month = (start || today).slice(0, 7); // YYYY-MM

    this.el.addEventListener('click', (e) => {
      const nav = e.target.closest('[data-cal]')?.dataset.cal;
      if (nav === 'prev') this.shiftMonth(-1);
      else if (nav === 'next') this.shiftMonth(1);
      else if (nav === 'month-all') this.toggleMonth();
      const day = e.target.closest('[data-day]')?.dataset.day;
      if (day && this.isSelectable(day)) {
        if (this.selected.has(day)) this.selected.delete(day);
        else this.selected.add(day);
        this.render();
        this.onChange(this.selected);
      }
    });
    this.render();
  }

  isSelectable(d) {
    return this.valid.has(d) && !this.tracked.has(d);
  }

  monthDays(month = this.month) {
    const [y, m] = month.split('-').map(Number);
    const count = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return Array.from({ length: count }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`);
  }

  shiftMonth(delta) {
    const [y, m] = this.month.split('-').map(Number);
    const d = new Date(Date.UTC(y, m - 1 + delta, 1));
    const next = d.toISOString().slice(0, 7);
    if (next < this.min.slice(0, 7) || next > this.max.slice(0, 7)) return;
    this.month = next;
    this.render();
  }

  toggleMonth() {
    const days = this.monthDays().filter((d) => this.isSelectable(d));
    const all = days.length && days.every((d) => this.selected.has(d));
    days.forEach((d) => (all ? this.selected.delete(d) : this.selected.add(d)));
    this.render();
    this.onChange(this.selected);
  }

  clear() {
    this.selected.clear();
    this.render();
    this.onChange(this.selected);
  }

  render() {
    const [y, m] = this.month.split('-').map(Number);
    const first = new Date(Date.UTC(y, m - 1, 1));
    const lead = (first.getUTCDay() + 6) % 7; // weeks start on Monday
    const title = first.toLocaleDateString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' });
    const weekdays = Array.from({ length: 7 }, (_, i) =>
      new Date(Date.UTC(2024, 0, 1 + i)).toLocaleDateString(undefined, { weekday: 'narrow', timeZone: 'UTC' }));
    const days = this.monthDays();
    const operating = days.filter((d) => this.valid.has(d)).length;
    const selectable = days.filter((d) => this.isSelectable(d));
    const allSelected = selectable.length && selectable.every((d) => this.selected.has(d));
    const canPrev = this.month > this.min.slice(0, 7);
    const canNext = this.month < this.max.slice(0, 7);

    const cells = days.map((d) => {
      const n = Number(d.slice(8));
      const known = d >= this.min && d <= this.max;
      const cls = ['cal-day'];
      let label = formatDateOnly(d);
      if (!known) {
        cls.push('unknown');
        label += ', schedule not available';
      } else if (this.tracked.has(d)) {
        cls.push('tracked');
        label += ', already tracking';
      } else if (this.valid.has(d)) {
        cls.push('valid');
        if (this.selected.has(d)) cls.push('selected');
      } else {
        cls.push('invalid');
        label += ', no flight';
      }
      if (d === this.today) cls.push('today');
      if (d < this.today) cls.push('past');
      const enabled = this.isSelectable(d);
      return `<button type="button" class="${cls.join(' ')}" data-day="${d}" aria-label="${esc(label)}"
        ${enabled ? `aria-pressed="${this.selected.has(d)}"` : 'disabled'}>${n}</button>`;
    });

    this.el.innerHTML = `
      <div class="cal-head">
        <button type="button" class="cal-nav" data-cal="prev" ${canPrev ? '' : 'disabled'} aria-label="Previous month">‹</button>
        <div class="cal-title">${esc(title)} <small>${operating} flight day${operating === 1 ? '' : 's'}</small></div>
        <button type="button" class="cal-nav" data-cal="next" ${canNext ? '' : 'disabled'} aria-label="Next month">›</button>
      </div>
      <div class="cal-grid">
        ${weekdays.map((w) => `<div class="cal-wd">${esc(w)}</div>`).join('')}
        ${'<div></div>'.repeat(lead)}
        ${cells.join('')}
      </div>
      <div class="cal-foot">
        <span class="cal-key"><i class="k-valid"></i>Flies</span>
        <span class="cal-key"><i class="k-invalid"></i>No flight</span>
        <span class="cal-key"><i class="k-tracked"></i>Tracking</span>
        <button type="button" data-cal="month-all" ${selectable.length ? '' : 'disabled'}>
          ${allSelected ? 'Clear month' : 'Select whole month'}
        </button>
      </div>
    `;
  }
}
