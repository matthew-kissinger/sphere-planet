/** Minimal text HUD. */

export class Hud {
  private stats = document.getElementById('stats')!;
  private msg = document.getElementById('msg')!;
  private msgTimer = 0;

  setStats(lines: string[]): void {
    this.stats.textContent = lines.join('\n');
  }

  flash(text: string, seconds = 6): void {
    this.msg.textContent = text;
    this.msgTimer = seconds;
  }

  tick(dt: number): void {
    if (this.msgTimer > 0) {
      this.msgTimer -= dt;
      if (this.msgTimer <= 0) this.msg.textContent = '';
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
