import type { CourierRallySnapshot, CourierRouteResult } from './courierRally';
import type { FrontierSnapshot } from './frontierMode';

export type CourierScreen = 'title' | 'routes' | 'controls' | 'settings' | 'pause' | 'complete' | 'failed' | 'hidden';

export type CourierUiAction =
  | { type: 'play'; routeId?: string }
  | { type: 'play-frontier' }
  | { type: 'play-creative' }
  | { type: 'show-routes' }
  | { type: 'show-controls' }
  | { type: 'show-settings' }
  | { type: 'show-title' }
  | { type: 'resume' }
  | { type: 'restart' }
  | { type: 'quit' }
  | { type: 'next-route' }
  | { type: 'toggle-audio' }
  | { type: 'toggle-motion' };

export interface CourierRouteOption {
  id: string;
  name: string;
  summary: string;
  ringCount: number;
}

export interface CourierScreenModel {
  screen: CourierScreen;
  selectedRouteId: string;
  routes: CourierRouteOption[];
  result: CourierRouteResult | null;
  failReason: string;
  audioEnabled: boolean;
  reducedMotion: boolean;
  frontier: FrontierSnapshot;
}

const FIELD_NAMES = [
  'objective',
  'target',
  'timer',
  'score',
  'chain',
  'speed',
  'alt',
  'agl',
  'progress',
  'hint',
] as const;

type HudField = typeof FIELD_NAMES[number];

function formatTime(seconds: number): string {
  const safe = Math.max(0, seconds);
  const minutes = Math.floor(safe / 60);
  const whole = Math.floor(safe % 60);
  const tenths = Math.floor((safe - Math.floor(safe)) * 10);
  return `${minutes}:${String(whole).padStart(2, '0')}.${tenths}`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function renderResult(result: CourierRouteResult | null): string {
  if (!result) return '';
  return `
    <div class="rally-results">
      <div><span>Medal</span><strong>${result.medal}</strong></div>
      <div><span>Time</span><strong>${formatTime(result.adjustedSeconds)}</strong></div>
      <div><span>Rings</span><strong>${result.ringsHit}/${result.ringCount}</strong></div>
      <div><span>Landing</span><strong>${result.landingQuality}%</strong></div>
      <div><span>Score</span><strong>${result.score.toLocaleString()}</strong></div>
      <div><span>Best Chain</span><strong>x${result.bestChain}</strong></div>
    </div>
  `;
}

function renderFrontierResult(frontier: FrontierSnapshot): string {
  if (frontier.status !== 'complete') return '';
  return `
    <div class="rally-frontier-results">
      <div><span>Contract</span><strong>${escapeHtml(frontier.contractName || 'Frontier')}</strong></div>
      <div><span>Prep Time</span><strong>${formatTime(frontier.prepSeconds)}</strong></div>
      <div><span>Materials</span><strong>${frontier.gathered.wood}/${frontier.required.wood} W · ${frontier.gathered.rock}/${frontier.required.rock} R</strong></div>
      <div><span>Build</span><strong>${frontier.padPlaced}/${frontier.padTotal} + ${frontier.beaconPlaced ? 'beacon' : 'no beacon'}</strong></div>
      <div><span>Quality</span><strong>${frontier.buildQuality}%</strong></div>
    </div>
  `;
}

export class CourierUi {
  private readonly overlay = document.createElement('div');
  private readonly hud = document.createElement('div');
  private readonly fields = new Map<HudField, HTMLElement>();
  private readonly actions: CourierUiAction[] = [];
  private screenCache = '';
  private lastScreen: CourierScreen = 'hidden';

  constructor(parent: HTMLElement = document.body) {
    this.overlay.id = 'rally-menu';
    this.overlay.className = 'rally-menu';
    this.hud.id = 'rally-hud';
    this.hud.className = 'rally-hud hidden';
    this.hud.innerHTML = `
      <div class="rally-hud__top">
        <div class="rally-objective">
          <span data-rally-field="objective">Objective</span>
          <strong data-rally-field="target">Target</strong>
        </div>
        <div class="rally-counters">
          <div><span>Time</span><strong data-rally-field="timer">0:00.0</strong></div>
          <div><span>Score</span><strong data-rally-field="score">0</strong></div>
          <div><span>Chain</span><strong data-rally-field="chain">x0</strong></div>
        </div>
      </div>
      <div class="rally-hud__bottom">
        <div class="rally-flight">
          <span data-rally-field="speed">000 m/s</span>
          <span data-rally-field="alt">ALT 000</span>
          <span data-rally-field="agl">AGL 000</span>
        </div>
        <div class="rally-progress"><span data-rally-field="progress">0/0</span></div>
      </div>
      <div class="rally-hint" data-rally-field="hint"></div>
    `;
    for (const field of FIELD_NAMES) {
      const el = this.hud.querySelector(`[data-rally-field="${field}"]`);
      if (el instanceof HTMLElement) this.fields.set(field, el);
    }
    this.overlay.addEventListener('click', this.onClick);
    parent.appendChild(this.overlay);
    parent.appendChild(this.hud);
  }

  consumeAction(): CourierUiAction | null {
    return this.actions.shift() ?? null;
  }

  renderScreen(model: CourierScreenModel): void {
    const key = JSON.stringify({
      screen: model.screen,
      selectedRouteId: model.selectedRouteId,
      result: model.result,
      failReason: model.failReason,
      audioEnabled: model.audioEnabled,
      reducedMotion: model.reducedMotion,
      frontier: {
        status: model.frontier.status,
        contractId: model.frontier.contractId,
        prepSeconds: Math.round(model.frontier.prepSeconds),
        padPlaced: model.frontier.padPlaced,
        padTotal: model.frontier.padTotal,
        beaconPlaced: model.frontier.beaconPlaced,
        buildQuality: model.frontier.buildQuality,
      },
      routes: model.routes.map((route) => route.id),
    });
    if (key === this.screenCache) return;
    this.screenCache = key;
    this.lastScreen = model.screen;
    this.overlay.classList.toggle('hidden', model.screen === 'hidden');
    this.overlay.innerHTML = this.renderPanel(model);
  }

  setHud(snapshot: CourierRallySnapshot, speed: number, altitude: number, agl: number): void {
    const visible = snapshot.status !== 'menu';
    this.hud.classList.toggle('hidden', !visible);
    if (!visible) return;
    this.setField('objective', snapshot.objective);
    this.setField('target', snapshot.targetLabel);
    this.setField('timer', formatTime(snapshot.adjustedSeconds));
    this.setField('score', snapshot.score.toLocaleString());
    this.setField('chain', `x${snapshot.chain}`);
    this.setField('speed', `${Math.round(speed).toString().padStart(3, '0')} m/s`);
    this.setField('alt', `ALT ${Math.round(altitude).toString().padStart(3, '0')}`);
    this.setField('agl', `AGL ${Math.round(agl).toString().padStart(3, '0')}`);
    this.setField('progress', `${snapshot.ringsHit}/${snapshot.ringCount}`);
    this.setField('hint', snapshot.hint);
    this.hud.classList.toggle('countdown', snapshot.status === 'countdown');
    this.hud.classList.toggle('failed', snapshot.status === 'failed');
    this.hud.classList.toggle('complete', snapshot.status === 'complete');
  }

  private setField(field: HudField, value: string): void {
    const el = this.fields.get(field);
    if (el && el.textContent !== value) el.textContent = value;
  }

  private renderPanel(model: CourierScreenModel): string {
    if (model.screen === 'hidden') return '';
    if (model.screen === 'routes') return this.renderRoutes(model);
    if (model.screen === 'controls') return this.renderControls();
    if (model.screen === 'settings') return this.renderSettings(model);
    if (model.screen === 'pause') return this.renderPause();
    if (model.screen === 'complete') return this.renderComplete(model);
    if (model.screen === 'failed') return this.renderFailed(model);
    return this.renderTitle(model);
  }

  private renderTitle(model: CourierScreenModel): string {
    const route = model.routes.find((item) => item.id === model.selectedRouteId) ?? model.routes[0];
    return `
      <section class="rally-panel rally-title">
        <div class="rally-mark">PCR</div>
        <p class="rally-kicker">Goldberg Planet</p>
        <h1>Planet Courier Rally</h1>
        <p class="rally-copy">${escapeHtml(route.summary)}</p>
        <div class="rally-route-chip">${escapeHtml(route.name)} · ${route.ringCount} rings</div>
        <div class="rally-actions">
          <button data-action="play" class="primary">Play</button>
          <button data-action="play-frontier">Frontier</button>
          <button data-action="play-creative">Creative</button>
          <button data-action="show-routes">Routes</button>
          <button data-action="show-controls">Controls</button>
          <button data-action="show-settings">Settings</button>
        </div>
      </section>
    `;
  }

  private renderRoutes(model: CourierScreenModel): string {
    const routeButtons = model.routes.map((route) => `
      <button class="rally-route${route.id === model.selectedRouteId ? ' selected' : ''}" data-action="play" data-route="${route.id}">
        <strong>${escapeHtml(route.name)}</strong>
        <span>${escapeHtml(route.summary)}</span>
        <em>${route.ringCount} rings + delivery</em>
      </button>
    `).join('');
    return `
      <section class="rally-panel">
        <p class="rally-kicker">Route Select</p>
        <h2>Courier Runs</h2>
        <div class="rally-route-list">${routeButtons}</div>
        <div class="rally-actions">
          <button data-action="show-title">Back</button>
          <button data-action="show-controls">Controls</button>
        </div>
      </section>
    `;
  }

  private renderControls(): string {
    return `
      <section class="rally-panel">
        <p class="rally-kicker">Controls</p>
        <h2>Flight Deck</h2>
        <div class="rally-control-grid">
          <span>W/S</span><strong>Throttle</strong>
          <span>Mouse/Drag</span><strong>Steer</strong>
          <span>Space/Ctrl</span><strong>Climb / descend</strong>
          <span>Shift</span><strong>Boost</strong>
          <span>E</span><strong>Board / stow plane</strong>
          <span>Frontier</span><strong>Chop, mine, place, then E launches</strong>
          <span>Creative</span><strong>Full hotbar, plane unlocked, free-flight</strong>
          <span>Esc</span><strong>Pause</strong>
        </div>
        <div class="rally-actions">
          <button data-action="show-title">Back</button>
          <button data-action="play" class="primary">Play</button>
        </div>
      </section>
    `;
  }

  private renderSettings(model: CourierScreenModel): string {
    return `
      <section class="rally-panel">
        <p class="rally-kicker">Settings</p>
        <h2>Run Options</h2>
        <div class="rally-settings">
          <button data-action="toggle-audio"><span>Sound</span><strong>${model.audioEnabled ? 'On' : 'Off'}</strong></button>
          <button data-action="toggle-motion"><span>Flashes</span><strong>${model.reducedMotion ? 'Reduced' : 'Full'}</strong></button>
        </div>
        <div class="rally-actions">
          <button data-action="show-title">Back</button>
          <button data-action="play" class="primary">Play</button>
        </div>
      </section>
    `;
  }

  private renderPause(): string {
    return `
      <section class="rally-panel compact">
        <p class="rally-kicker">Paused</p>
        <h2>Delivery Hold</h2>
        <div class="rally-actions vertical">
          <button data-action="resume" class="primary">Resume</button>
          <button data-action="restart">Restart Route</button>
          <button data-action="show-controls">Controls</button>
          <button data-action="quit">Quit to Menu</button>
        </div>
      </section>
    `;
  }

  private renderComplete(model: CourierScreenModel): string {
    return `
      <section class="rally-panel">
        <p class="rally-kicker">Delivery Complete</p>
        <h2>${model.result?.routeName ?? 'Route Complete'}</h2>
        ${renderResult(model.result)}
        ${renderFrontierResult(model.frontier)}
        <div class="rally-actions">
          <button data-action="restart">Retry</button>
          <button data-action="next-route" class="primary">Next Route</button>
          <button data-action="show-routes">Routes</button>
          <button data-action="quit">Menu</button>
        </div>
      </section>
    `;
  }

  private renderFailed(model: CourierScreenModel): string {
    return `
      <section class="rally-panel compact failed">
        <p class="rally-kicker">Run Failed</p>
        <h2>${escapeHtml(model.failReason || 'Delivery interrupted')}</h2>
        <div class="rally-actions vertical">
          <button data-action="restart" class="primary">Retry</button>
          <button data-action="show-routes">Routes</button>
          <button data-action="quit">Menu</button>
        </div>
      </section>
    `;
  }

  private onClick = (event: MouseEvent): void => {
    const button = (event.target as HTMLElement).closest('button[data-action]') as HTMLElement | null;
    if (!button) return;
    event.preventDefault();
    const action = button.dataset.action;
    const routeId = button.dataset.route;
    if (action === 'play') this.actions.push({ type: 'play', routeId });
    if (action === 'play-frontier') this.actions.push({ type: 'play-frontier' });
    if (action === 'play-creative') this.actions.push({ type: 'play-creative' });
    if (action === 'show-routes') this.actions.push({ type: 'show-routes' });
    if (action === 'show-controls') this.actions.push({ type: 'show-controls' });
    if (action === 'show-settings') this.actions.push({ type: 'show-settings' });
    if (action === 'show-title') this.actions.push({ type: 'show-title' });
    if (action === 'resume') this.actions.push({ type: 'resume' });
    if (action === 'restart') this.actions.push({ type: 'restart' });
    if (action === 'quit') this.actions.push({ type: 'quit' });
    if (action === 'next-route') this.actions.push({ type: 'next-route' });
    if (action === 'toggle-audio') this.actions.push({ type: 'toggle-audio' });
    if (action === 'toggle-motion') this.actions.push({ type: 'toggle-motion' });
  };
}
