/**
 * The diagnostics overlay: what the analysis layer currently believes, what
 * Jev has cost so far, and what the timeline expects next. Hidden until `H`.
 *
 * `update` merges, so each subsystem can push only the fields it owns.
 */

export interface HudData {
  bpm?: number;
  beatConf?: number;
  key?: string;
  mode?: string;
  tempo?: string;
  loud?: string;
  speech?: number;
  mood?: Record<string, number | string>;
  tokensTotal?: number;
  calls?: number;
  lastLatencyMs?: number;
  upcoming?: { dt: number; label: string }[];
  latencyTrimMs?: number;
}

export interface Hud {
  update(d: HudData): void;
  toggle(): void;
}

const TRIM_MIN = -200;
const TRIM_MAX = 200;
const TRIM_STEP = 5;

export function createHud(root: HTMLElement, onTrim: (ms: number) => void): Hud {
  const data: HudData = {};

  const hud = document.createElement('div');
  hud.className = 'hud';
  hud.hidden = true;

  const rows = document.createElement('div');
  rows.className = 'hud-rows';

  const upcoming = document.createElement('div');
  upcoming.className = 'hud-upcoming';

  const trimLabel = document.createElement('label');
  trimLabel.className = 'hud-trim';

  const trimText = document.createElement('span');
  trimText.className = 'hud-trim-name';
  trimText.textContent = 'latency trim';

  const trim = document.createElement('input');
  trim.type = 'range';
  trim.min = String(TRIM_MIN);
  trim.max = String(TRIM_MAX);
  trim.step = String(TRIM_STEP);
  trim.value = '0';

  const trimValue = document.createElement('span');
  trimValue.className = 'hud-trim-value';
  trimValue.textContent = '0 ms';

  trim.addEventListener('input', () => {
    const ms = Number(trim.value);
    trimValue.textContent = `${ms} ms`;
    data.latencyTrimMs = ms;
    onTrim(ms);
  });

  trimLabel.append(trimText, trim, trimValue);
  hud.append(rows, upcoming, trimLabel);
  root.append(hud);

  function render(): void {
    const pairs: [string, string][] = [];
    const push = (k: string, v: string | undefined): void => {
      if (v !== undefined) pairs.push([k, v]);
    };

    push('bpm', num(data.bpm, 1));
    push('beat', num(data.beatConf, 2));
    push('key', data.key);
    push('mode', data.mode);
    push('tempo', data.tempo);
    push('loud', data.loud);
    push('speech', num(data.speech, 2));
    for (const [k, v] of Object.entries(data.mood ?? {})) {
      push(k, typeof v === 'number' ? num(v, 2) : v);
    }
    push('tokens', num(data.tokensTotal, 0));
    push('calls', num(data.calls, 0));
    push('latency', data.lastLatencyMs === undefined ? undefined : `${Math.round(data.lastLatencyMs)} ms`);

    rows.replaceChildren(
      ...pairs.map(([k, v]) => {
        const row = document.createElement('div');
        row.className = 'hud-row';
        const key = document.createElement('span');
        key.className = 'hud-key';
        key.textContent = k;
        const val = document.createElement('span');
        val.className = 'hud-val';
        val.textContent = v;
        row.append(key, val);
        return row;
      }),
    );

    upcoming.replaceChildren(
      ...(data.upcoming ?? []).map((c) => {
        const line = document.createElement('div');
        line.className = 'hud-cue';
        line.textContent = `+${c.dt.toFixed(1)}s ${c.label}`;
        return line;
      }),
    );
  }

  window.addEventListener('keydown', (e) => {
    if (e.key !== 'h' && e.key !== 'H') return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (isTyping(e.target)) return;
    hud.hidden = !hud.hidden;
  });

  render();

  return {
    update(d: HudData): void {
      Object.assign(data, d);
      if (d.latencyTrimMs !== undefined) {
        trim.value = String(d.latencyTrimMs);
        trimValue.textContent = `${d.latencyTrimMs} ms`;
      }
      render();
    },
    toggle(): void {
      hud.hidden = !hud.hidden;
    },
  };
}

function num(v: number | undefined, digits: number): string | undefined {
  return v === undefined ? undefined : v.toFixed(digits);
}

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}
