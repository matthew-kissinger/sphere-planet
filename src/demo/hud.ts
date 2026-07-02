/**
 * HUD: a single dim vitals line (F3 expands full diagnostics), transient toasts above
 * the hotbar, a flight strip while airborne, and a tap/click-selectable hotbar.
 * The help block fades itself out after a few seconds of play; H brings it back.
 */

export interface HotbarSlot {
  name: string;
  css: string;
  count: number;
}

export class Hud {
  onSlotSelect: ((i: number) => void) | null = null;
  private vitals = document.getElementById('vitals')!;
  private diag = document.getElementById('diag')!;
  private msg = document.getElementById('msg')!;
  private flight = document.getElementById('flight')!;
  private slot = document.getElementById('slotname')!;
  private help = document.getElementById('help')!;
  private hotbar = document.getElementById('hotbar')!;
  private hotbarCache = '';
  private vitalsCache = '';
  private msgTimer = 0;
  private slotTimer = 0;
  private helpTimer = 25;
  private helpShown = true;

  constructor() {
    this.hotbar.addEventListener('pointerdown', (e) => {
      const el = (e.target as HTMLElement).closest('.slot') as HTMLElement | null;
      if (el?.dataset.i !== undefined) {
        e.stopPropagation();
        this.onSlotSelect?.(Number(el.dataset.i));
      }
    });
  }

  setVitals(text: string): void {
    if (text !== this.vitalsCache) {
      this.vitals.textContent = text;
      this.vitalsCache = text;
    }
  }

  setDiag(lines: string[] | null): void {
    if (lines === null) {
      if (this.diag.style.display !== 'none') this.diag.style.display = 'none';
      return;
    }
    this.diag.style.display = 'block';
    this.diag.textContent = lines.join('\n');
  }

  setFlight(text: string | null): void {
    if (text === null) {
      if (this.flight.style.display !== 'none') this.flight.style.display = 'none';
      return;
    }
    this.flight.style.display = 'block';
    if (this.flight.textContent !== text) this.flight.textContent = text;
  }

  setHotbar(slots: HotbarSlot[], sel: number): void {
    const html = slots.map((s, i) =>
      `<div class="slot${i === sel ? ' sel' : ''}" data-i="${i}"><div class="swatch" style="background:${s.css}"></div>` +
      `<span class="key">${i + 1}</span><span class="count">${s.count}</span></div>`,
    ).join('');
    if (html !== this.hotbarCache) {
      this.hotbar.innerHTML = html;
      this.hotbarCache = html;
    }
  }

  /** transient toast above the hotbar */
  flash(text: string, seconds = 4): void {
    this.msg.textContent = text;
    this.msg.classList.add('on');
    this.msgTimer = seconds;
  }

  /** brief label under the toast line when the selected block changes */
  slotName(text: string): void {
    this.slot.textContent = text;
    this.slot.classList.add('on');
    this.slotTimer = 1.3;
  }

  toggleHelp(): void {
    this.helpShown = !this.helpShown;
    this.help.classList.toggle('hide', !this.helpShown);
    this.helpTimer = this.helpShown ? 30 : 0;
  }

  tick(dt: number): void {
    if (this.msgTimer > 0) {
      this.msgTimer -= dt;
      if (this.msgTimer <= 0) this.msg.classList.remove('on');
    }
    if (this.slotTimer > 0) {
      this.slotTimer -= dt;
      if (this.slotTimer <= 0) this.slot.classList.remove('on');
    }
    if (this.helpShown && this.helpTimer > 0) {
      this.helpTimer -= dt;
      if (this.helpTimer <= 0) {
        this.helpShown = false;
        this.help.classList.add('hide');
      }
    }
  }
}

export function splash(msg: string, frac: number): void {
  const bar = document.getElementById('splashbar');
  const label = document.getElementById('splashmsg');
  if (bar) bar.style.width = `${Math.round(frac * 100)}%`;
  if (label) label.textContent = msg;
}

export function hideSplash(): void {
  document.getElementById('splash')?.remove();
}
