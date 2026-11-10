"use client";
import { useEffect, useRef, useState } from "react";

// A draggable map pin for a venue (design: Setup step 3 and OwnerLocation, 10 Nov 2026). Search finds the
// town or suburb (Open-Meteo geocoding, server-side); the Owner drags the pin onto the venue and confirms.
// Leaflet and OpenStreetMap tiles load in the browser only; the form posts the pin's coordinates.
type LeafletMap = { setView: (c: [number, number], z: number) => void; remove: () => void };
type LeafletMarker = { setLatLng: (c: [number, number]) => void; getLatLng: () => { lat: number; lng: number }; on: (e: string, f: () => void) => void };
type Leaflet = { map: (el: HTMLElement) => LeafletMap & { on: (e: string, f: (ev: { latlng: { lat: number; lng: number } }) => void) => void }; tileLayer: (url: string, o: object) => { addTo: (m: unknown) => void }; marker: (c: [number, number], o: object) => LeafletMarker & { addTo: (m: unknown) => LeafletMarker } };
declare global { interface Window { L?: Leaflet } }
const LEAFLET = "https://unpkg.com/leaflet@1.9.4/dist/leaflet";

function loadLeaflet(): Promise<Leaflet> {
  if (window.L) return Promise.resolve(window.L);
  return new Promise((resolve, reject) => {
    const css = document.createElement("link"); css.rel = "stylesheet"; css.href = `${LEAFLET}.css`; document.head.appendChild(css);
    const script = document.createElement("script"); script.src = `${LEAFLET}.js`; script.onload = () => window.L ? resolve(window.L) : reject(new Error("map")); script.onerror = () => reject(new Error("map"));
    document.head.appendChild(script);
  });
}

type Place = { name: string; region: string | null; country: string | null; latitude: number; longitude: number };
export function PinMap({ initial, initialQuery }: { initial: { latitude: number; longitude: number } | null; initialQuery: string }) {
  const box = useRef<HTMLDivElement>(null);
  const marker = useRef<LeafletMarker | null>(null);
  const map = useRef<LeafletMap | null>(null);
  const [point, setPoint] = useState(initial);
  const [query, setQuery] = useState(initialQuery);
  const [places, setPlaces] = useState<Place[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [mapFailed, setMapFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    loadLeaflet().then(L => {
      if (cancelled || !box.current || map.current) return;
      const start: [number, number] = initial ? [initial.latitude, initial.longitude] : [0, 20];
      const m = L.map(box.current); m.setView(start, initial ? 16 : 2); map.current = m;
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap contributors" }).addTo(m);
      const pin = L.marker(start, { draggable: true }).addTo(m); marker.current = pin;
      pin.on("dragend", () => { const at = pin.getLatLng(); setPoint({ latitude: at.lat, longitude: at.lng }); });
      m.on("click", ev => { pin.setLatLng([ev.latlng.lat, ev.latlng.lng]); setPoint({ latitude: ev.latlng.lat, longitude: ev.latlng.lng }); });
    }).catch(() => setMapFailed(true));
    return () => { cancelled = true; map.current?.remove(); map.current = null; };
  }, [initial]);

  async function search() {
    setMessage(null);
    const response = await fetch(`/api/geocode?q=${encodeURIComponent(query)}`).catch(() => null);
    const body = response?.ok ? await response.json() as { results: Place[] } : null;
    if (!body) { setMessage("The place search isn’t available right now. Drag the pin or try again."); return; }
    setPlaces(body.results);
    if (!body.results.length) setMessage("No place found. Try the suburb or town name.");
  }
  function choose(place: Place) {
    setPoint({ latitude: place.latitude, longitude: place.longitude });
    marker.current?.setLatLng([place.latitude, place.longitude]);
    map.current?.setView([place.latitude, place.longitude], 16);
    setPlaces([]);
  }
  return <div className="pin-map">
    <div className="filter-row"><label>Find the suburb or town<input value={query} onChange={e => setQuery(e.target.value)} onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); void search(); } }} maxLength={100} /></label><button type="button" className="secondary-button" onClick={() => void search()}>Find</button></div>
    {places.length ? <ul className="place-results">{places.map(place => <li key={`${place.latitude},${place.longitude}`}><button type="button" className="link-button" onClick={() => choose(place)}>{[place.name, place.region, place.country].filter(Boolean).join(", ")}</button></li>)}</ul> : null}
    {message ? <p className="note" role="status">{message}</p> : null}
    <div ref={box} className="pin-map-canvas" style={{ height: 320, borderRadius: 12 }} aria-label="Map: drag the pin onto your venue" />
    {mapFailed ? <p className="note">The map couldn’t load. Enter the coordinates instead.</p> : null}
    <div className="form-grid">
      <label>Latitude<input name="latitude" value={point ? point.latitude.toFixed(6) : ""} onChange={e => setPoint({ latitude: Number(e.target.value), longitude: point?.longitude ?? 0 })} required inputMode="decimal" /></label>
      <label>Longitude<input name="longitude" value={point ? point.longitude.toFixed(6) : ""} onChange={e => setPoint({ latitude: point?.latitude ?? 0, longitude: Number(e.target.value) })} required inputMode="decimal" /></label>
    </div>
    <p className="tiny">Map data © OpenStreetMap contributors · place search by Open-Meteo.com</p>
  </div>;
}
