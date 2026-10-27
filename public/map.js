// Route map for a tracked flight: great-circle route between the airports, the
// part already flown, and the plane's live (or estimated) position.
// Leaflet is loaded on first use so pages without an open map stay light.

const LEAFLET_URL = 'https://unpkg.com/leaflet@1.9.4/dist/';
const LEAFLET_SRI = {
  js: 'sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=',
  css: 'sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=',
};
const PLANE_SVG =
  '<svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true"><path fill="currentColor" stroke="#fff" stroke-width="1" ' +
  'd="M12 1.5c.8 0 1.4.9 1.4 2V9l8.1 4.6v2.1l-8.1-2.5v5.1l2.3 1.8v1.6L12 20.8l-3.7.9v-1.6l2.3-1.8v-5.1l-8.1 2.5v-2.1L10.6 9V3.5c0-1.1.6-2 1.4-2z"/></svg>';

let leafletPromise = null;

function loadLeaflet() {
  if (window.L) return Promise.resolve(window.L);
  if (!leafletPromise) {
    leafletPromise = new Promise((resolve, reject) => {
      const css = Object.assign(document.createElement('link'), {
        rel: 'stylesheet', href: `${LEAFLET_URL}leaflet.css`, integrity: LEAFLET_SRI.css, crossOrigin: '',
      });
      const js = Object.assign(document.createElement('script'), {
        src: `${LEAFLET_URL}leaflet.js`, integrity: LEAFLET_SRI.js, crossOrigin: '',
      });
      js.onload = () => resolve(window.L);
      js.onerror = () => {
        leafletPromise = null;
        reject(new Error('Could not load the map. Check your connection and try again.'));
      };
      document.head.append(css, js);
    });
  }
  return leafletPromise;
}

const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;

// Points along the great circle from a to b ([lat, lon]). Longitudes are unwrapped
// so the line doesn't jump across the map at the antimeridian.
function greatCircle(a, b, steps = 96) {
  const [φ1, λ1, φ2, λ2] = [rad(a[0]), rad(a[1]), rad(b[0]), rad(b[1])];
  const d = 2 * Math.asin(Math.sqrt(Math.sin((φ2 - φ1) / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin((λ2 - λ1) / 2) ** 2));
  if (d === 0) return [a, b];
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const f = i / steps;
    const A = Math.sin((1 - f) * d) / Math.sin(d);
    const B = Math.sin(f * d) / Math.sin(d);
    const x = A * Math.cos(φ1) * Math.cos(λ1) + B * Math.cos(φ2) * Math.cos(λ2);
    const y = A * Math.cos(φ1) * Math.sin(λ1) + B * Math.cos(φ2) * Math.sin(λ2);
    const z = A * Math.sin(φ1) + B * Math.sin(φ2);
    pts.push([deg(Math.atan2(z, Math.hypot(x, y))), deg(Math.atan2(y, x))]);
  }
  for (let i = 1; i < pts.length; i++) pts[i][1] = nearLon(pts[i][1], pts[i - 1][1]);
  return pts;
}

// The equivalent of lon (±360) closest to ref.
function nearLon(lon, ref) {
  while (lon - ref > 180) lon -= 360;
  while (lon - ref < -180) lon += 360;
  return lon;
}

function bearing(a, b) {
  const [φ1, φ2, Δλ] = [rad(a[0]), rad(b[0]), rad(b[1] - a[1])];
  return (deg(Math.atan2(Math.sin(Δλ) * Math.cos(φ2), Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ))) + 360) % 360;
}

// Split a path at fraction f (0..1) of its points: [flown, remaining, pointAtF].
function splitPath(path, f) {
  const x = Math.max(0, Math.min(1, f)) * (path.length - 1);
  const i = Math.floor(x);
  const t = x - i;
  const b = path[Math.min(i + 1, path.length - 1)];
  const p = [path[i][0] + (b[0] - path[i][0]) * t, path[i][1] + (b[1] - path[i][1]) * t];
  return [[...path.slice(0, i + 1), p], [p, ...path.slice(i + 1)], p];
}

class FlightMap {
  constructor(el) {
    this.el = el;
    this.routeKey = null;
    this.ready = loadLeaflet()
      .then((L) => {
        this.L = L;
        this.map = L.map(el, { scrollWheelZoom: false, worldCopyJump: true });
        L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
          maxZoom: 18,
          attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        }).addTo(this.map);
        this.layer = L.layerGroup().addTo(this.map);
      })
      .catch((err) => {
        el.innerHTML = `<div class="error map-msg">${esc(err.message)}</div>`;
      });
  }

  // progressOf(leg) -> 0..100 or null, the same estimate the card's progress bar uses.
  async update(legs, progressOf) {
    await this.ready;
    if (!this.map || !this.el.isConnected) return;
    const L = this.L;
    this.layer.clearLayers();
    const bounds = [];

    for (const leg of legs) {
      const dep = leg.departure;
      const arr = leg.arrival;
      if (dep.lat == null || arr.lat == null) continue;
      const path = greatCircle([dep.lat, dep.lon], [arr.lat, arr.lon]);
      const progress = progressOf(leg);
      const [flown, remaining, estimate] = splitPath(path, (progress ?? 0) / 100);
      const cancelled = leg.status === 'cancelled';

      L.polyline(remaining, { className: 'route-ahead', weight: 2, dashArray: '6 6' }).addTo(this.layer);
      if (!cancelled && progress > 0) L.polyline(flown, { className: 'route-flown', weight: 3 }).addTo(this.layer);
      for (const [p, e] of [[path[0], dep], [path[path.length - 1], arr]]) {
        L.circleMarker(p, { radius: 5, className: 'airport-dot' })
          .bindTooltip(esc(e.iata || e.icao || ''), { permanent: true, direction: 'top', className: 'airport-label' })
          .addTo(this.layer);
      }
      bounds.push(...path);

      // Plane: live position when the provider has one, otherwise estimated from the times.
      const pos = leg.position;
      if (!cancelled && (pos || (progress > 0 && progress < 100))) {
        const at = pos ? [pos.lat, nearLon(pos.lon, estimate[1])] : estimate;
        const ahead = splitPath(path, Math.min(1, (progress ?? 0) / 100 + 0.01))[2];
        const heading = pos?.heading ?? bearing(at, ahead);
        const icon = L.divIcon({
          className: 'plane-icon',
          html: `<span style="transform:rotate(${Math.round(heading)}deg)">${PLANE_SVG}</span>`,
          iconSize: [26, 26],
          iconAnchor: [13, 13],
        });
        L.marker(at, { icon, keyboard: false })
          .bindTooltip(pos ? `Live position${pos.at ? `, ${relTime(Date.parse(pos.at))}` : ''}` : 'Estimated position')
          .addTo(this.layer);
      }
    }

    if (!bounds.length) {
      this.el.dataset.empty = 'Route map appears after the next refresh.';
      return;
    }
    delete this.el.dataset.empty;
    // Only re-fit when the route changes, so the user's own panning/zooming sticks.
    const key = legs.map((l) => `${l.departure.iata}-${l.arrival.iata}`).join(',');
    if (key !== this.routeKey) {
      this.routeKey = key;
      this.map.invalidateSize();
      this.map.fitBounds(bounds, { padding: [30, 30] });
    }
  }

  destroy() {
    this.map?.remove();
    this.map = null;
  }
}
