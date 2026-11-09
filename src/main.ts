import './styles.css';
import { picture } from './state/data.ts';
import { app } from './state/app.ts';
import { createMap, flyTo, getMap } from './map/mapView.ts';
import { initPanel } from './ui/panel.ts';
import {
  initAlerts, initCaption, initClock, initIntro, initKeys, initLayers, initStatus, openAbout, closeAbout, openSearch, toggleLayersPanel,
  initNews, initNearby, initLog, toggleNews, toggleNearby, toggleLog,
} from './ui/chrome.ts';
import type { Gallery } from './gallery/gallery.ts';

const mapReady = createMap(document.getElementById('map')!);
picture.start();
initIntro(mapReady);
initClock();
initCaption();
initStatus();
initPanel();
initLayers();
initAlerts();
initNews();
initNearby();
initLog();

// The Index pulls in three.js, so it loads the first time it is opened.
let gallery: Gallery | null = null;
async function toggleIndex() {
  if (!gallery) {
    const { Gallery } = await import('./gallery/gallery.ts');
    gallery = new Gallery(document.getElementById('index')!, (p) => {
      gallery!.close();
      const t = p.target;
      if (t.kind !== 'none') app.select({ kind: t.kind, id: t.id });
      else app.select(null);
      flyTo(t.lon, t.lat, t.zoom);
    });
  }
  gallery.toggle();
}

const home = () => {
  app.select(null);
  getMap().flyTo({ center: [getMap().getCenter().lng, 25], zoom: 1.7, speed: 1.2, essential: true });
};

initKeys({ index: toggleIndex, home });
app.on('selection', () => {
  const s = app.selection;
  picture.seaSel = s?.kind === 'sea' ? Number(s.id.slice(2)) : 0;
});

document.querySelector('.top')!.addEventListener('click', (e) => {
  const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
  if (act === 'search') openSearch();
  if (act === 'layers') toggleLayersPanel();
  if (act === 'news') toggleNews();
  if (act === 'nearby') toggleNearby();
  if (act === 'log') toggleLog();
  if (act === 'index') toggleIndex();
  if (act === 'about') (document.getElementById('about')!.hidden ? openAbout() : closeAbout());
  if (act === 'home') home();
});
document.getElementById('status')!.addEventListener('click', (e) => {
  if ((e.target as HTMLElement).closest('[data-act="about"]')) openAbout();
});
document.addEventListener('pointerdown', (e) => {
  const lp = document.getElementById('layers')!;
  if (!lp.hidden && !lp.contains(e.target as Node) && !(e.target as HTMLElement).closest('[data-act="layers"]')) toggleLayersPanel(false);
});

// A slow drift on the globe until someone touches it.
mapReady.then((map) => {
  let spinning = !location.hash;
  const stop = () => { spinning = false; };
  map.on('mousedown', stop);
  map.on('touchstart', stop);
  map.on('wheel', stop);
  app.on('selection', stop);
  let last = performance.now();
  const spin = (t: number) => {
    const dt = Math.min(100, t - last);
    last = t;
    if (spinning && !gallery?.isOpen && map.getZoom() < 3 && !map.isMoving()) {
      const c = map.getCenter();
      map.setCenter([c.lng + dt * 0.0022, c.lat]);
    }
    if (spinning) requestAnimationFrame(spin);
  };
  requestAnimationFrame(spin);

  // Deep link: #a:<hex> or #s:<mmsi>
  const want = decodeURIComponent(location.hash.slice(1));
  if (/^[as]:/.test(want)) {
    const tryOpen = () => {
      const t = picture.get(want);
      if (!t) return false;
      app.select({ kind: want.startsWith('a:') ? 'air' : 'sea', id: want });
      flyTo(t.x, t.y, 8);
      return true;
    };
    const off = picture.on(() => { if (tryOpen()) off(); });
  }
});

if (import.meta.env.DEV) (window as any).__wf = { app, picture, getMap };
