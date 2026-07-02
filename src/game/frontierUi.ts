import type { FrontierSnapshot } from './frontierMode';

function fmtSeconds(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return `${minutes}:${String(rest).padStart(2, '0')}`;
}

export class FrontierUi {
  private readonly root = document.createElement('div');
  private cache = '';

  constructor(parent: HTMLElement = document.body) {
    this.root.id = 'frontier-hud';
    this.root.className = 'frontier-hud hidden';
    parent.appendChild(this.root);
  }

  render(snapshot: FrontierSnapshot): void {
    const visible = snapshot.status === 'prepping' || snapshot.status === 'ready';
    this.root.classList.toggle('hidden', !visible);
    if (!visible) {
      this.cache = '';
      this.root.innerHTML = '';
      return;
    }

    const html = `
      <div class="frontier-hud__head">
        <span>${snapshot.contractName}</span>
        <strong>${snapshot.objective}</strong>
      </div>
      <div class="frontier-hud__grid">
        <div><span>Wood</span><strong>${snapshot.gathered.wood}/${snapshot.required.wood}</strong></div>
        <div><span>Rock</span><strong>${snapshot.gathered.rock}/${snapshot.required.rock}</strong></div>
        <div><span>Pad</span><strong>${snapshot.padPlaced}/${snapshot.padTotal}</strong></div>
        <div><span>Beacon</span><strong>${snapshot.beaconPlaced ? 'Ready' : 'Missing'}</strong></div>
      </div>
      <div class="frontier-hud__foot">
        <span>Prep ${fmtSeconds(snapshot.prepSeconds)} · quality ${snapshot.buildQuality}%</span>
        <strong>${snapshot.canLaunch ? 'Press E to launch' : snapshot.hint}</strong>
      </div>
    `;
    if (html === this.cache) return;
    this.cache = html;
    this.root.innerHTML = html;
  }
}
