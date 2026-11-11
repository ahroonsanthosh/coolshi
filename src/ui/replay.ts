// The replay bar: scrub or play the last few hours. Live again with Esc,
// the Live button, or P.

import { closeReplay, onReplay, openReplay, pause, play, replay, seek } from '../state/replay.ts';
import { toast } from './chrome.ts';
import * as F from '../lib/format.ts';

const el = () => document.getElementById('replay')!;

function draw() {
  const box = el();
  if (!replay.active) { box.hidden = true; document.body.classList.remove('replaying'); return; }
  box.hidden = false;
  document.body.classList.add('replaying');
  const ago = (Date.now() - replay.t) / 1000;
  const slider = box.querySelector<HTMLInputElement>('input[type=range]');
  if (!slider) {
    box.innerHTML = `
      <span class="rp-tag">Replay</span>
      <span class="rp-time"><b></b><span></span></span>
      <button class="rp-play" data-act="rp-play"></button>
      <input type="range" aria-label="Time" />
      <select aria-label="Speed" data-act="rp-speed">
        <option value="30">30×</option><option value="60" selected>60×</option><option value="240">240×</option>
      </select>
      <button class="rp-live" data-act="rp-live">Live</button>`;
    const s = box.querySelector<HTMLInputElement>('input[type=range]')!;
    s.addEventListener('input', () => { pause(); seek(Number(s.value)); });
    return draw();
  }
  slider.min = String(replay.from);
  slider.max = String(replay.to);
  slider.step = '10000';
  if (document.activeElement !== slider) slider.value = String(replay.t);
  slider.setAttribute('aria-valuetext', `${F.utc(replay.t)} UTC`);
  box.querySelector('.rp-time b')!.textContent = `${F.utc(replay.t)} UTC`;
  box.querySelector('.rp-time span')!.textContent = replay.loading ? 'loading…' : `${F.ago(ago)}`;
  const pb = box.querySelector<HTMLButtonElement>('.rp-play')!;
  pb.textContent = replay.playing ? 'Pause' : 'Play';
  pb.setAttribute('aria-pressed', String(replay.playing));
}

export async function toggleReplay() {
  if (replay.active) return closeReplay();
  const ok = await openReplay();
  if (!ok) toast('Replay', 'The server keeps the last few hours once it has been running a while. Nothing to replay yet.', null, 'info', 10_000);
}

export function initReplay() {
  const box = el();
  box.addEventListener('click', (e) => {
    const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
    if (act === 'rp-play') (replay.playing ? pause() : play());
    if (act === 'rp-live') closeReplay();
  });
  box.addEventListener('change', (e) => {
    const t = e.target as HTMLSelectElement;
    if (t.dataset.act === 'rp-speed') replay.speed = Number(t.value);
  });
  onReplay(draw);
  setInterval(() => { if (replay.active) draw(); }, 1000);
}
