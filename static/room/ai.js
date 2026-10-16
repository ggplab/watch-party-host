// AI manager panel and spoiler shield. Talks to the same-origin backend: POST /ask, POST /shield.
// All user-visible text is set with textContent.

/** "MM:SS" or "H:MM:SS" or a number -> seconds. Anything else -> null. */
export function toSec(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? Math.max(0, Math.floor(v)) : null;
  if (typeof v !== 'string') return null;
  const parts = v.trim().split(':');
  if (parts.length < 2 || parts.length > 3 || parts.some((p) => !/^\d+$/.test(p))) return null;
  return parts.reduce((acc, p) => acc * 60 + Number(p), 0);
}

export function mmss(sec) {
  const t = Number.isFinite(sec) && sec > 0 ? Math.floor(sec) : 0;
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = String(t % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${String(m).padStart(2, '0')}:${s}`;
}

async function postJSON(url, body, timeoutMs) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body), signal: ctl.signal,
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally { clearTimeout(timer); }
}

export function askBackend(videoId, tSec, question) {
  return postJSON('/ask', { video_id: videoId, t_sec: Math.floor(tSec), question }, 60000);
}

const LOCK_UNKNOWN = 'Locked: scene not identified';
const lockLater = (sec) => 'Locked: a later scene, opens at ' + mmss(sec);

/**
 * Spoiler shield. Every message id goes to /shield exactly once (batched).
 * view(id) is evaluated locally against the viewer's current time and never calls the backend.
 * Anything not yet classified, or whose classification failed, stays hidden (fail closed).
 */
export function createShield({ getT, getVideoId, onUpdate }) {
  const info = new Map();      // id -> { status: 'pending' | 'ok' | 'fail', refers: sec | null, social: bool }
  let buffer = [];
  let timer = 0;

  async function flush() {
    timer = 0;
    const batch = buffer;
    buffer = [];
    for (let i = 0; i < batch.length; i += 20) {
      const chunk = batch.slice(i, i + 20);
      try {
        const res = await postJSON('/shield', {
          video_id: getVideoId(), t_sec: Math.floor(getT()),
          messages: chunk.map((m) => ({ id: m.id, text: m.text })),
        }, 30000);
        const byId = new Map(((res && res.results) || []).map((r) => [r.id, r]));
        for (const m of chunk) {
          const r = byId.get(m.id);
          if (r) info.set(m.id, { status: 'ok', refers: toSec(r.refers_to), social: !!r.social });
          else info.set(m.id, { status: 'fail', refers: null, social: false });
        }
      } catch {
        for (const m of chunk) info.set(m.id, { status: 'fail', refers: null, social: false });
      }
      onUpdate(chunk.map((m) => m.id));
    }
  }

  /** Queue messages that have never been sent. Returns nothing; onUpdate fires when results land. */
  function request(list) {
    let added = false;
    for (const m of list) {
      if (!m || !m.id || info.has(m.id)) continue;
      info.set(m.id, { status: 'pending', refers: null, social: false });
      buffer.push({ id: m.id, text: m.text });
      added = true;
    }
    if (added && !timer) timer = setTimeout(flush, 150);
  }

  /** { visible, label }. label is the only thing that may be shown while hidden. */
  function view(id) {
    const i = info.get(id);
    if (!i || i.status !== 'ok') return { visible: false, label: LOCK_UNKNOWN };
    if (i.social) return { visible: true, label: '' };
    if (i.refers == null) return { visible: false, label: LOCK_UNKNOWN };
    if (i.refers > getT()) return { visible: false, label: lockLater(i.refers) };
    return { visible: true, label: '' };
  }

  return { request, view };
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

/**
 * AI manager panel. mount: element to fill.
 * getT(): viewer's current video time in seconds. getVideoId(): current video id. seekTo(sec): move the viewer's player.
 * Returns { ask(question), renderFriends(list) } where list is [{ name, t }] (t in seconds).
 */
export function createAIPanel({ mount, getT, getVideoId, seekTo }) {
  const RECAP_Q = '지금까지 무슨 일이 있었는지 요약해 줘';
  mount.textContent = '';

  const sum = el('summary', null, 'AI manager');
  const body = el('div', 'ai-body');
  const catchBtn = el('button', 'primary', 'Catch me up');
  catchBtn.type = 'button';
  const form = el('form', 'ai-form');
  form.autocomplete = 'off';
  const input = el('input');
  input.type = 'text';
  input.maxLength = 200;
  input.placeholder = 'Ask about the story so far';
  input.setAttribute('aria-label', 'Question');
  const askBtn = el('button', 'ghost', 'Ask');
  askBtn.type = 'submit';
  form.append(input, askBtn);
  const row = el('div', 'ai-row');
  row.append(catchBtn);
  const tLabel = el('span', 'ai-t', '');
  row.append(tLabel);
  const card = el('div', 'ai-card');
  card.hidden = true;
  const friendsBox = el('div', 'ai-friends');
  body.append(row, form, card, friendsBox);
  mount.append(sum, body);

  function tick() { tLabel.textContent = 'You are at ' + mmss(getT()); }
  tick();
  setInterval(tick, 1000);

  function showMessage(text) {
    card.hidden = false;
    card.replaceChildren(el('p', 'ai-ko', text));
  }

  function renderAnswer(r, t) {
    card.hidden = false;
    card.replaceChildren();
    if (!r || r.answerable === false) {
      card.append(el('p', 'ai-ko', 'Not shown yet at ' + mmss(t) + '.'));
      return;
    }
    card.append(el('p', 'ai-ko', r.answer_ko || ''));
    if (r.answer_en) card.append(el('p', 'ai-en', r.answer_en));
    const cites = Array.isArray(r.cites) ? r.cites : [];
    if (cites.length) {
      const chips = el('div', 'ai-chips');
      for (const c of cites) {
        const s = toSec(c);
        if (s == null) continue;
        const b = el('button', 'chip', mmss(s));
        b.type = 'button';
        b.addEventListener('click', () => seekTo(s));
        chips.append(b);
      }
      card.append(chips);
    }
    const foot = r.cached
      ? 'cached (demo replay)'
      : 'answered from Argon scene log, ' + ((Number(r.latency_ms) || 0) / 1000).toFixed(1) + ' s';
    card.append(el('p', 'ai-foot', foot));
  }

  let busy = false;
  async function ask(question) {
    if (busy) return null;
    busy = true;
    catchBtn.disabled = true;
    askBtn.disabled = true;
    const t = getT();
    showMessage('Thinking...');
    try {
      const r = await askBackend(getVideoId(), t, question);
      renderAnswer(r, t);
      return r;
    } catch {
      showMessage('Could not reach the AI manager. Try again in a moment.');
      return null;
    } finally {
      busy = false;
      catchBtn.disabled = false;
      askBtn.disabled = false;
    }
  }

  catchBtn.addEventListener('click', () => ask(RECAP_Q));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const q = input.value.trim();
    if (!q) return;
    ask(q);
  });

  function renderFriends(list) {
    friendsBox.replaceChildren();
    for (const f of list) {
      if (!Number.isFinite(f.t)) continue;
      const b = el('button', 'chip friend', f.name + ' ▶ ' + mmss(f.t));
      b.type = 'button';
      b.addEventListener('click', () => seekTo(f.t));
      friendsBox.append(b);
    }
    friendsBox.hidden = !friendsBox.childElementCount;
  }
  renderFriends([]);

  return { ask, renderFriends, RECAP_Q };
}
