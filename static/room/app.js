// 시청회 채팅 + 방장 싱크. 프로토콜은 ARCHITECTURE.md 「실시간 프로토콜」 참조.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';
import { createPlayer } from '/static/room/player.js';
import { createShield, createAIPanel, toSec } from '/static/room/ai.js';

window.__wpsBooted = true;

const cfg = window.CHAT_CONFIG;
const { expectedPos, acceptState, sanitizeState, sanitizeMsg, sanitizeHistory, sanitizeReact, sanitizeRecap,
  summarizeReactions, formatReactions, recapDue, keyboardInset,
  driftAction, parseYouTubeId, fmtTime, watchUrl, hostGone, mergeMsgs } = window.syncCore;
const { colorFor, isEmoji, makeGate } = window.chatCore;
const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const DEMO = params.get('demo') === '1';
const DEMO_VIDEO = 'mE8yrHFjatQ';
const DEMO_T0 = 1200;            // demo viewer starts at 20:00
let demoT = DEMO_T0;
let demoStart = Date.now();

const SESSION_KEY = 'wps.hostSession';
const sess = {
  get() { try { return JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null'); } catch { return null; } },
  set(v) { try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(v)); } catch { /* 저장 못 해도 동작은 한다 */ } },
  clear() { try { sessionStorage.removeItem(SESSION_KEY); } catch { /* */ } },
};
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* 저장 못 해도 동작은 한다 */ } },
};

if (!cfg || !cfg.SUPABASE_URL || cfg.SUPABASE_URL.includes('여기에')) {
  $('statusline').textContent = '설정이 없습니다. config.example.js 를 config.js 로 복사해 값을 채우세요.';
  throw new Error('CHAT_CONFIG is missing');
}

/* ── 기본 상태 ─────────────────────────────────────────────── */
const room = (params.get('room') || store.get('wps.room') || cfg.DEFAULT_ROOM || 'demo').trim().slice(0, 40);
if (params.get('room')) store.set('wps.room', room);
$('roomLabel').textContent = '#' + room;

const WORDS = cfg.NICKNAME_WORDS;
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const randomName = () => (pick(WORDS.first) + ' ' + pick(WORDS.second)).slice(0, 12);

// id 는 페이지(연결)마다 새로 만든다. 저장하지 않으므로 같은 브라우저의 두 탭이 서로 다른 사람이고,
// 방장 권한과 presence 가 탭 단위로 갈린다.
const me = {
  id: crypto.randomUUID(),
  name: (store.get('wps.name') || '').slice(0, 12),
};
if (!me.name) { me.name = randomName(); store.set('wps.name', me.name); }
// 같은 사람이 새로고침하거나 탭을 더 열어도 "새로 온 사람" 알림이 반복되지 않게 하는 사람 id(방장 권한과는 무관)
me.uid = store.get('wps.uid') || crypto.randomUUID();
store.set('wps.uid', me.uid);

const EPISODES = Array.isArray(cfg.EPISODES) ? cfg.EPISODES : [];
const epLabel = (videoId) => (EPISODES.find((e) => e.videoId === videoId) || {}).label || '';
const HOST_LIMIT = params.has('hg') ? Number(params.get('hg')) : undefined;   // 테스트용으로만 쓴다
const CHAT_MAX = 200;
const HISTORY_MAX = 50;
const COOLDOWN = 1200;

let hostState = null;            // 마지막으로 받아들인 방장 상태 + receivedAt
let seq = 0;
// 자동 따라가기는 저장하지 않는다. 페이지를 열 때마다 켜짐으로 시작한다(?follow=0 은 시험용).
let autoFollow = params.get('follow') !== '0';
// 이 페이지에서 사용자 제스처(우리 문서의 pointerdown, keydown)가 있었는가. iframe 안의 탭은 우리 문서로 오지 않으므로
// 첫 제스처 전의 정지는 자동재생 차단으로 본다.
let gestured = false;
let gestureAt = 0;
let playStart = 0;
let wasBusy = false;
let everPlayed = false;          // 이 페이지에서 내 플레이어가 한 번이라도 재생했는가
let notPlayingSince = 0;         // 큰 버튼 조건이 처음 참이 된 시각 (버퍼링 깜빡임 방지)
let chatOnly = params.has('chat');
let presence = [];
let presenceSynced = false;
let hostAbsentSince = 0;
let joinedAt = Date.now();
let msgs = [];
const seen = new Set();
const accept = makeGate(cfg);
let ready = false;
let channel = null;
let player = null;
let playerPromise = null;
let lastPos = null;
let lastPosAt = 0;
let lastSentVideo = null;
let followedAt = 0;              // 재생을 시도하기 시작한 시각. 실제로 재생에 성공했을 때만 0 으로 지운다
let autoplayBlocked = false;
let hostReady = true;            // false: 방장을 넘겨받았지만 내 플레이어가 아직 그 상태에 못 맞췄다
let delegated = null;            // 넘겨받은 상태. hostReady 가 되기 전까지 이 값을 흘려 송신한다
let pendingDelegation = null;    // 내가 방장을 넘기는 중
let restoring = false;           // 새로고침한 방장이 자리 복귀 여부를 기다리는 중
let restoreTried = false;
let noHostSince = 0;

const isHost = () => !!hostState && hostState.hostId === me.id;

function toast(text, ms = 3200) {
  const t = $('toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, ms);
}
function showBanner(text) { if (DEMO) text = ''; $('banner').textContent = text || ''; $('banner').hidden = !text; }

/* ── 내 시청 시각과 영상 (AI 패널, 스포일러 방패가 쓴다) ───────────── */
function getMyT() {
  // TV mode: everyone is at the broadcast time (the host's position), not their own player position
  if (DEMO) return demoT;
  if (hostState) return currentExpected(Date.now());
  return player ? player.getTime() : 0;
}
function getVideoIdNow() {
  return (player && player.getVideoId()) || (hostState && hostState.videoId) || (EPISODES[0] && EPISODES[0].videoId) || DEMO_VIDEO;
}
/** 친구 위치 칩이나 AI 시각 칩을 눌렀을 때 내 플레이어를 옮긴다 */
function seekMy(sec) {
  return;  // TV mode: viewers cannot move; the broadcast time is the host's
  if (DEMO) demoT = sec;
  ensurePlayer().then((p) => {
    if (!DEMO && autoFollow && hostState && !isHost()) { setAutoFollow(false); toast('Auto follow is off while you look around'); }
    p.seek(sec);
    if (DEMO) p.pause();
  }).catch(() => {});
  refreshLocks();
}

/* ── 플레이어 ─────────────────────────────────────────────── */
function ensurePlayer() {
  if (player) return Promise.resolve(player);
  if (!playerPromise) {
    playerPromise = createPlayer({ container: $('player'), fake: params.has('fakeplayer'), muted: params.has('mute'),
                                  placeholderId: (hostState && hostState.videoId) || (EPISODES[0] && EPISODES[0].videoId) })
      .then((p) => {
        player = p;
        p.onChange(onPlayerEvent);
        if (hostState && !isHost() && !chatOnly) follow(false);
        return p;
      })
      .catch((err) => {
        playerPromise = null;
        showBanner('유튜브 플레이어를 불러오지 못했습니다. 네트워크를 확인하고 새로고침해 주세요');
        throw err;
      });
  }
  return playerPromise;
}

function onPlayerEvent(ev) {
  if (ev.type === 'error') {
    const code = ev.code;
    showBanner(code === 101 || code === 150 || code === 153
      ? '이 영상은 임베드가 막혀 있어 여기서 재생할 수 없습니다. 유튜브 앱에서 열기를 써 주세요'
      : '영상을 재생하지 못했습니다 (오류 ' + code + ')');
    return;
  }
  if (ev.type === 'autoplayBlocked') { autoplayBlocked = true; renderHint(); return; }
  if (ev.type !== 'state') return;
  if (ev.playing) { followedAt = 0; autoplayBlocked = false; renderHint(); }
  else if (ev.byUser && !gestured && !isHost()) {
    // 제스처 없이 재생이 멈췄다: 잠깐 재생되다 브라우저 정책에 막힌 것이다. 따라가기는 그대로 두고 큰 버튼을 띄운다
    autoplayBlocked = true;
    renderHint();
    return;
  }   // 재생에 성공했을 때만 지운다
  if (isHost()) {
    if (ev.byUser) hostReady = true;          // 넘겨받은 직후라도 사람이 직접 조작했으면 그 상태가 기준이다
    sendState();
    return;
  }
  // 앱이 낸 명령의 결과와 다른 조작(참가자가 직접 멈추거나 재생)이면 방장과 싸우지 않도록 따라가기를 끈다.
  if (ev.byUser && autoFollow && hostState && ev.playing !== hostState.playing) {
    setAutoFollow(false);
    toast('직접 조작해서 자동 따라가기를 껐습니다');
  }
}

/** 방장 상태에 내 플레이어를 맞춘다. manual 이면 자동 따라가기 설정과 3초 기준을 모두 건너뛰고 맞춘다. */
function follow(manual) {
  if (!player || !hostState || isHost() || chatOnly) return;
  if (!manual && !autoFollow) return;
  alignTo(hostState, manual);
}

function alignTo(state, manual) {
  if (!player || !state.videoId) return;
  const now = Date.now();
  const local = { videoId: player.getVideoId(), pos: player.getTime() };
  const a = driftAction(state, local, now, manual);
  if (a.action === 'load') {
    player.load(state.videoId, a.pos, state.playing);
    if (state.playing && !followedAt) followedAt = now;
    return;
  }
  if (a.action === 'seek') {
    if (!manual && player.busy()) return;       // 방금 낸 명령이 아직 도착하기 전이면 자동 보정으로 덧씌우지 않는다
    player.seek(a.pos);
  }
  if (state.playing && !player.isPlaying()) { player.play(); if (!followedAt) followedAt = now; }
  else if (!state.playing && player.isPlaying()) player.pause();
  if (!state.playing) followedAt = 0;
}

function setAutoFollow(v) {
  autoFollow = true;  // TV mode: viewers always follow the host
  renderControls();
}

/* ── 방장 ─────────────────────────────────────────────────── */
function buildState() {
  if (!hostReady && delegated) {
    // 넘겨받은 직후: 내 플레이어가 아직 따라오지 못했으니 받은 상태를 시간만 흘려 그대로 보낸다
    return {
      term: hostState.term, hostId: me.id, hostName: me.name, videoId: delegated.videoId,
      title: delegated.title, pos: expectedPos(delegated, Date.now()), playing: delegated.playing, seq: ++seq,
    };
  }
  const videoId = player ? player.getVideoId() : null;
  const title = player ? player.getTitle() : '';
  return {
    term: hostState ? hostState.term : 1,
    hostId: me.id,
    hostName: me.name,
    videoId: videoId || null,
    title: title || epLabel(videoId) || '',
    pos: player ? player.getTime() : 0,
    playing: player ? player.isPlaying() : false,
    seq: ++seq,
  };
}

async function sendState() {
  if (!isHost() || (hostReady && !player)) return;
  const s = buildState();
  hostState = { ...s, receivedAt: Date.now() };
  lastSentVideo = s.videoId;
  // 새로고침해도 방장으로 돌아올 수 있게 탭 단위로 저장한다(sessionStorage 는 탭마다 따로다)
  sess.set({ room, term: s.term, wasHost: true, videoId: s.videoId, pos: s.pos, playing: s.playing, savedAt: Date.now() });
  renderStatus();
  await sendEv('state', s);
}

async function takeOver() {
  try { await ensurePlayer(); } catch { return; }
  if (chatOnly) setChatOnly(false);
  const term = (hostState ? hostState.term : 0) + 1;
  if (!player.getVideoId() && EPISODES[0]) player.load(EPISODES[0].videoId, 0, false);
  seq = Date.now();
  hostReady = true; delegated = null;
  const wasHost = isHost();
  hostState = {
    term, hostId: me.id, hostName: me.name, videoId: player.getVideoId() || null, title: '',
    pos: player.getTime(), playing: player.isPlaying(), seq: 0, receivedAt: Date.now(),
  };
  if (!wasHost) onRoleChange();
  await sendState();
}

function hostLoad(videoId) {
  if (!isHost() || !player) return;
  player.load(videoId, 0, true);
  sendState();
  renderHostTools();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 방장 넘기기. 내가 먼저 내려오지 않는다. 새 방장의 새 term 상태를 받아야(onState) 내려오고,
 *  못 받으면 8초 뒤 더 큰 term 으로 되돌린다. 전송은 ack 가 올 때까지 최대 3번 다시 보낸다. */
async function delegate(target) {
  if (!isHost() || !player || pendingDelegation) return;
  const term = hostState.term + 1;
  const mine = { target, term };
  pendingDelegation = mine;
  toast(target.name + ' 님에게 방장을 넘기는 중...');
  for (let i = 0; i < 3 && pendingDelegation === mine; i++) {
    const s = {
      term, hostId: target.id, hostName: target.name,
      videoId: player.getVideoId() || null, title: player.getTitle() || '',
      pos: player.getTime(), playing: player.isPlaying(), seq: 0,
    };
    if (await sendEv('state', s)) break;
    await sleep(1500);
  }
  setTimeout(() => {
    if (pendingDelegation !== mine || !isHost()) return;
    pendingDelegation = null;
    // 다른 참가자는 이미 위임 상태를 받았을 수 있으니 더 큰 term 으로 방장 자리를 되찾는다
    hostState = { ...hostState, term: term + 1 };
    seq = Date.now();
    sendState();
    toast('방장 넘기기를 확인하지 못해 그대로 방장입니다');
  }, 8000);
}

/** 방장을 넘겨받았다. 채팅만 모드 해제, 플레이어 준비, 받은 상태 적용, 적용 확인 뒤에야 내 플레이어 값을 송신한다.
 *  그때까지는 받은 상태를 시간만 흘려 그대로 보낸다. */
async function acceptDelegation() {
  hostReady = false;
  delegated = { ...hostState };
  seq = hostState.seq;
  onRoleChange();
  sendState();
  if (chatOnly) setChatOnly(false);
  try { await ensurePlayer(); } catch { return; }
  if (!isHost() || hostReady) return;
  alignTo(delegated, true);
  const t0 = Date.now();
  let realigned = 0;
  const iv = setInterval(() => {
    if (!isHost() || hostReady || !delegated) { clearInterval(iv); return; }
    const now = Date.now();
    const exp = expectedPos(delegated, now);
    const ok = player.getVideoId() === delegated.videoId && Math.abs(player.getTime() - exp) <= 3
      && player.isPlaying() === delegated.playing;
    if (ok) { hostReady = true; delegated = null; clearInterval(iv); sendState(); return; }
    if (now - t0 > 2500 * (realigned + 1) && realigned < 3) { realigned++; alignTo(delegated, true); }
  }, 300);
}

/** 방장이 되었거나 내려왔을 때 한 번 */
function onRoleChange(wasHost = false) {
  if (isHost()) { document.body.classList.add('is-host'); trackingNew = false; trackNewcomers(); }
  else {
    document.body.classList.remove('is-host');
    hostReady = true; delegated = null;
    trackingNew = false; pendingNew.clear();
    if (wasHost) autoFollow = true;
  }
  trackPresence();
  renderAll();
}

/* ── 채널 ─────────────────────────────────────────────────── */
const supabase = createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
  realtime: { params: { eventsPerSecond: 20 } },
});
let reconnectTimer = null;
let helloTimers = [];

function setupChannel() {
  if (channel) { try { supabase.removeChannel(channel); } catch { /* 이미 닫힘 */ } }
  ready = false;
  const ch = supabase.channel('watch:' + room, {
    config: { broadcast: { self: false, ack: true }, presence: { key: me.id } },
  });
  channel = ch;
  ch.on('broadcast', { event: 'state' }, ({ payload }) => onState(payload))
    .on('broadcast', { event: 'hello' }, ({ payload }) => onHello(payload))
    .on('broadcast', { event: 'history' }, ({ payload }) => onHistory(payload))
    .on('broadcast', { event: 'msg' }, ({ payload }) => onMsg(payload))
    .on('broadcast', { event: 'react' }, ({ payload }) => onReact(payload))
    .on('broadcast', { event: 'recap' }, ({ payload }) => onRecap(payload))
    .on('presence', { event: 'sync' }, () => { if (ch === channel) onPresence(ch.presenceState()); });
  ch.subscribe((s) => { if (ch === channel) onChannelStatus(s); });
}

function onChannelStatus(s) {
  ready = s === 'SUBSCRIBED';
  $('status').classList.toggle('on', ready);
  $('send').disabled = !ready || cooling;
  if (ready) {
    showBanner('');
    trackPresence();
    sayHello();
    if (isHost()) sendState();
    maybeRestoreHost();
  } else if (s === 'CHANNEL_ERROR' || s === 'TIMED_OUT' || s === 'CLOSED') {
    showBanner('연결이 끊겼습니다. 다시 연결하는 중...');
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => { if (!ready) setupChannel(); }, 3000);
  }
}

function trackPresence() {
  if (!channel || !ready) return;
  channel.track({ id: me.id, uid: me.uid, name: me.name, host: isHost(),
    vt: player && player.getVideoId() ? Math.floor(player.getTime()) : null });
}

async function sendEv(event, payload) {
  if (!channel || !ready) return false;
  try {
    const res = await channel.send({ type: 'broadcast', event, payload });
    return res === 'ok';
  } catch { return false; }
}

function sayHello() {
  helloTimers.forEach(clearTimeout);
  // 구독에 성공할 때마다 첫 hello 는 보낸다(폰 잠금 뒤 복귀해도 빠진 채팅을 history 로 받는다).
  // 방장 상태를 아직 못 받았으면 몇 번 더 보낸다.
  helloTimers = [0, 2000, 5000, 9000].map((ms, i) => setTimeout(() => {
    if (ready && (i === 0 || !hostState)) sendEv('hello', { id: me.id });
  }, ms));
}

function onHello(p) {
  if (!p || typeof p.id !== 'string' || !p.id || p.id.length > 64 || p.id === me.id) return;
  if (isHost()) {
    sendState();
    sendEv('history', { to: p.id, msgs: msgs.filter((m) => !m.local).slice(-HISTORY_MAX) });
    return;
  }
  // 살아 있는 방장이 없으면 접속자 중 연결 id 가 가장 작은 한 명이 history 만 대신 보낸다
  if (!presenceSynced || restoring || !hostIsGone(Date.now())) return;
  const ids = presence.map((x) => x.id).filter((id) => id !== p.id);
  if (ids.length && ids.every((id) => id >= me.id) && ids.includes(me.id)) {
    sendEv('history', { to: p.id, msgs: msgs.filter((m) => !m.local).slice(-HISTORY_MAX) });
  }
}

/** 새로고침 전에 방장이었으면(같은 방, 60초 이내) 잠깐 다른 방장을 기다렸다가 없으면 term+1 로 돌아온다 */
function maybeRestoreHost() {
  if (restoreTried) return;
  restoreTried = true;
  const saved = sess.get();
  if (!saved || saved.room !== room || !saved.wasHost || !Number.isInteger(saved.term)
      || !(Date.now() - saved.savedAt <= 60000)) { sess.clear(); return; }
  restoring = true;
  setTimeout(async () => {
    restoring = false;
    if (hostState && hostState.hostId !== me.id && hostState.term >= saved.term) { sess.clear(); renderAll(); return; }   // 다른 방장이 있다
    if (isHost()) return;
    const elapsed = saved.playing ? (Date.now() - saved.savedAt) / 1000 : 0;
    const videoId = parseYouTubeId(saved.videoId);
    const baseTerm = Math.max(saved.term, hostState ? hostState.term : 0);
    hostState = {
      term: baseTerm + 1, hostId: me.id, hostName: me.name, videoId, title: '',
      pos: Math.max(0, (Number(saved.pos) || 0) + elapsed), playing: !!saved.playing, seq: Date.now(), receivedAt: Date.now(),
    };
    toast('새로고침 전의 방장 자리로 돌아왔습니다');
    acceptDelegation();          // 플레이어를 저장된 영상과 위치에 맞춘 뒤에 송신을 이어받는다
  }, 1800);
}

function onState(payload) {
  const s = sanitizeState(payload);
  if (!s || !acceptState(hostState, s)) return;
  const wasHost = isHost();
  hostState = { ...s, receivedAt: Date.now() };
  if (isHost() && !wasHost) {
    acceptDelegation();
    return;
  }
  if (!isHost() && wasHost) {
    if (pendingDelegation) toast(pendingDelegation.target.name + ' 님에게 방장을 넘겼습니다');
    pendingDelegation = null;
    sess.clear();                 // 방장을 넘겼거나 잃었다. 새로고침해도 돌아오지 않는다
    onRoleChange(true);
  }
  if (!isHost()) follow(false);
  renderStatus();
  renderControls();
}

function onPresence(state) {
  const list = [];
  for (const key of Object.keys(state)) {
    const metas = state[key];
    const m = metas[metas.length - 1] || {};
    list.push({ id: m.id || key, uid: typeof m.uid === 'string' ? m.uid.slice(0, 64) : (m.id || key),
      name: String(m.name || '익명').slice(0, 12), host: !!m.host,
      vt: Number.isFinite(m.vt) ? Math.max(0, Math.floor(m.vt)) : null });
  }
  presence = list;
  presenceSynced = true;
  renderPeople();
  renderFriendChips();
  trackNewcomers();
}

/* ── 채팅 ─────────────────────────────────────────────────── */
/** 새로 온 사람 알림/요약 카드: 일반 메시지와 다른 배경의 시스템 카드 */
function recapNode(m) {
  const rc = m.recap;
  const box = document.createElement('div');
  box.className = 'recap' + (m.local ? ' local' : '');
  const line = (cls, text) => { const p = document.createElement('p'); p.className = cls; p.textContent = text; box.append(p); };
  line('head', rc.names.length ? `🆕 ${rc.names.join(', ')}님이 들어왔어요` : '📌 지금까지 요약');
  const where = rc.pos != null && rc.label ? ` (${rc.label} ${fmtTime(rc.pos)}까지)` : '';
  if (rc.content) { line('sub', '📺 지금까지' + where); line('body', rc.content); }
  line('sub', '💬 반응');
  line('body', rc.reactions);
  return box;
}

/** 스포일러 방패: 가려진 메시지는 원문을 DOM에 넣지 않고 안내 문구만 둔다 */
function msgView(m, mine) {
  if (mine || m.fromMe || m.kind === 'recap') return { visible: true, label: '' };
  return shield.view(m.id);
}

function msgNode(m, mine) {
  if (m.kind === 'recap' && m.recap) return recapNode(m);
  const v = msgView(m, mine);
  if (!v.visible) {
    const lk = document.createElement('p');
    lk.className = 'msg locked';
    lk.dataset.mid = m.id;
    lk.dataset.lock = v.label;
    lk.textContent = v.label;
    return lk;
  }
  const p = document.createElement('p');
  p.dataset.mid = m.id;
  p.dataset.lock = '';
  p.className = 'msg' + (mine ? ' me' : '');
  if (m.vt != null) {
    const chip = document.createElement('span');
    chip.className = 'vt';
    chip.textContent = fmtTime(m.vt);
    p.append(chip);
  }
  const b = document.createElement('b');
  b.textContent = m.name;
  b.style.color = colorFor(m.name);
  p.append(b, document.createTextNode(m.text));
  return p;
}

function addToLog(m, mine) {
  const log = $('log');
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 60;
  log.append(msgNode(m, mine));
  while (log.childElementCount > CHAT_MAX) log.firstElementChild.remove();
  if (atBottom || mine) log.scrollTop = log.scrollHeight;
}

function addToOverlay(m) {
  if (m.kind === 'recap' && m.recap) {
    const rc = m.recap;
    const first = rc.names.length ? `🆕 ${rc.names.join(', ')}님이 들어왔어요` : '📌 지금까지 요약';
    const sentence = (rc.content.split(/(?<=[.!?。])\s+/)[0] || '').slice(0, 80);
    m = { name: first, text: sentence ? ' ' + sentence : '' };
  }
  const box = $('ovChat');
  const el = document.createElement('div');
  el.className = 'ovmsg';
  const ttl = cfg.MESSAGE_TTL || 12000;
  el.style.setProperty('--fade-at', Math.max(0, ttl - 700) / 1000 + 's');
  const b = document.createElement('b');
  b.textContent = m.name;
  b.style.color = colorFor(m.name);
  el.append(b, document.createTextNode(m.text));
  box.append(el);
  while (box.childElementCount > (cfg.MAX_MESSAGES || 8)) box.firstElementChild.remove();
  setTimeout(() => el.remove(), ttl);
}

function rerenderLog() {
  const log = $('log');
  log.replaceChildren(...msgs.map((m) => msgNode(m, m.id && m.fromMe)));
  log.scrollTop = log.scrollHeight;
}

/** 시각이 바뀌었거나 방패 결과가 도착했을 때 잠금 상태가 달라진 줄만 다시 그린다 (방패를 다시 부르지 않는다) */
function refreshLocks() {
  const byId = new Map(msgs.map((x) => [x.id, x]));
  for (const node of $('log').querySelectorAll('[data-mid]')) {
    const m = byId.get(node.dataset.mid);
    if (!m) continue;
    const v = msgView(m, m.fromMe);
    if (v.label !== node.dataset.lock) node.replaceWith(msgNode(m, m.fromMe));
  }
}

function pushMsg(m, mine) {
  seen.add(m.id);
  msgs = mergeMsgs(msgs, [m], CHAT_MAX);
  if (mine) { const mm = msgs.find((x) => x.id === m.id); if (mm) mm.fromMe = true; }
  addToLog(m, mine);
  addToOverlay(m);
}

function onMsg(payload) {
  const m = sanitizeMsg(payload);
  if (!m || seen.has(m.id)) return;
  seen.add(m.id);
  if (seen.size > 5000) { seen.clear(); for (const x of msgs) seen.add(x.id); }
  const ok = accept({ name: m.name, text: m.text });
  if (!ok) return;
  msgs = mergeMsgs(msgs, [m], CHAT_MAX);
  addToLog(m, false);
  shield.request([m]);
  shieldOverlayLater(m);
}

/** 방패 결과가 오고 나서도 보이는 메시지만 영상 위에 띄운다 */
function shieldOverlayLater(m) {
  let tries = 0;
  const t = setInterval(() => {
    tries++;
    const v = shield.view(m.id);
    if (v.visible) { clearInterval(t); addToOverlay(m); }
    else if (tries > 80) clearInterval(t);
  }, 250);
}

function onHistory(p) {
  const list = sanitizeHistory(p, me.id);
  if (!list) return;
  const fresh = list.filter((m) => !seen.has(m.id));
  if (!fresh.length) return;
  for (const m of fresh) seen.add(m.id);
  msgs = mergeMsgs(msgs, fresh, CHAT_MAX);
  for (const m of msgs) if (m.kind === 'recap' && !m.local) noteRecapAt(m.recap.at);
  shield.request(fresh.filter((m) => m.kind !== 'recap' && !m.fromMe));
  rerenderLog();            // 새 메시지가 합쳐졌으면 개수와 상관없이 다시 그린다
}

let cooling = false;
function startCooldown() {
  cooling = true;
  let left = COOLDOWN;
  const btn = $('send');
  btn.disabled = true;
  const tick = setInterval(() => {
    left -= 100;
    btn.textContent = left > 0 ? `${(left / 1000).toFixed(1)}초` : '보내기';
    if (left <= 0) { clearInterval(tick); cooling = false; btn.disabled = !ready; }
  }, 100);
}

$('form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (cooling) return;
  const input = $('text');
  const text = input.value.trim().slice(0, 120);
  if (!text) return;
  if (!ready) { showBanner('아직 연결되지 않았습니다. 잠시 후 다시 시도해 주세요'); return; }
  const m = {
    id: crypto.randomUUID(), name: me.name, text,
    vt: player && player.getVideoId() ? Math.floor(player.getTime()) : null,
    ts: Date.now(),
  };
  input.value = '';
  startCooldown();
  if (!(await sendEv('msg', m))) {
    input.value = text;
    showBanner('전송 실패. 네트워크를 확인하고 다시 보내 주세요');
    return;
  }
  showBanner('');
  pushMsg(m, true);
  if (document.body.classList.contains('ov-write')) setOvWrite(false);
});

/* ── 반응 ─────────────────────────────────────────────────── */
let lastReactAt = 0;
function floatReaction(emoji, name) {
  const layer = $('reactLayer');
  if (layer.childElementCount > 14) return;
  const el = document.createElement('div');
  el.className = 'react';
  el.style.left = 8 + Math.random() * 78 + '%';
  el.textContent = emoji;
  if (name) { const s = document.createElement('small'); s.textContent = name; el.append(s); }
  layer.append(el);
  setTimeout(() => el.remove(), 2800);
}
function onReact(p) {
  const r = sanitizeReact(p, isEmoji);
  if (r) { noteReact(r.emoji); floatReaction(r.emoji, r.name); }
}
$('emojis').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-e]');
  if (!btn) return;
  const now = Date.now();
  if (now - lastReactAt < 400) return;
  lastReactAt = now;
  noteReact(btn.dataset.e);
  floatReaction(btn.dataset.e, '');
  sendEv('react', { name: me.name, emoji: btn.dataset.e });
});

/* ── 화면 모드 ────────────────────────────────────────────── */
let forcedOverlay = false;
let inFs = false;
const OV = ['show', 'dim', 'hide'];
let ovIdx = Math.max(0, OV.indexOf(store.get('wps.ov')));

function computeMode() {
  const w = window.innerWidth, h = window.innerHeight;
  if (forcedOverlay) return 'overlay';
  if (w >= 900 && h >= 500) return 'side';
  if (w > h && h < 500) return 'overlay';
  return 'portrait';
}
/* 안드로이드 크롬은 키보드가 뜨면 창 높이 자체를 줄인다. 세로 폰에서도 높이가 너비보다 작아져
   가로(overlay)로 잘못 바뀌고, 입력칸이 숨겨지며 키보드가 바로 닫혔다(2026-10-15 사용자 제보).
   키보드는 높이만 바꾸고 회전은 너비를 바꾸므로, 글을 쓰는 중에 너비가 그대로면 모드를 유지한다. */
let lastModeW = 0;
const isTyping = () => {
  const a = document.activeElement;
  return !!a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA') && a.type !== 'button';
};
// 채팅 입력칸에 커서가 있는 동안 body.typing (세로 폰에서 반응 줄과 방장 줄 버튼을 접는 데 쓴다)
$('text').addEventListener('focus', () => document.body.classList.add('typing'));
$('text').addEventListener('blur', () => document.body.classList.remove('typing'));
// focus 이벤트가 오지 않는 경우(창에 포커스가 없을 때 등)를 위해, 키보드로 크기가 바뀔 때도 실제 커서 위치로 다시 맞춘다
const syncTyping = () => document.body.classList.toggle('typing', document.activeElement === $('text'));
function applyMode() {
  syncTyping();
  const w = window.innerWidth;
  if (document.body.dataset.mode && isTyping() && w === lastModeW) return;
  lastModeW = w;
  const mode = computeMode();
  document.body.dataset.mode = mode;
  document.body.classList.toggle('forced', forcedOverlay);
  if (mode !== 'overlay') document.body.classList.remove('ov-write');
  if (mode === 'overlay' && chatOnly) setChatOnly(false);
}
function renderOv() {
  document.body.dataset.ov = OV[ovIdx];
  const labels = ['채팅 보이는 중', '채팅 흐리게', '채팅 숨김'];
  const btn = $('ovChatBtn');
  btn.textContent = ovIdx === 0 ? '💬' : ovIdx === 1 ? '💬 흐리게' : '💬 숨김';
  btn.setAttribute('aria-label', labels[ovIdx]);
}
function setOvWrite(on) {
  document.body.classList.toggle('ov-write', on);
  if (on) $('text').focus();
}
$('ovChatBtn').addEventListener('click', () => {
  ovIdx = (ovIdx + 1) % OV.length;
  store.set('wps.ov', OV[ovIdx]);
  renderOv();
});
$('ovWriteBtn').addEventListener('click', () => setOvWrite(!document.body.classList.contains('ov-write')));
$('ovExit').addEventListener('click', () => {
  forcedOverlay = false;
  if (inFs && document.fullscreenElement) document.exitFullscreen().catch(() => {});
  inFs = false;
  applyMode();
});
$('fsBtn').addEventListener('click', () => {
  if (chatOnly) setChatOnly(false);
  forcedOverlay = true;
  applyMode();
  const el = document.documentElement;
  if (el.requestFullscreen) {
    el.requestFullscreen().then(() => { inFs = true; }).catch(() => { /* iPhone 등은 CSS 꽉 채우기로 대신한다 */ });
  }
});
document.addEventListener('fullscreenchange', () => {
  if (inFs && !document.fullscreenElement) { inFs = false; forcedOverlay = false; applyMode(); }
});
window.addEventListener('resize', applyMode);

/* 가상 키보드: 레이아웃 뷰포트는 그대로고 visualViewport 만 줄어드는 브라우저가 있다.
   키보드가 가린 높이를 --kb, 보이는 높이를 --vvh 로 내려 입력창이 키보드 위에 오게 한다. */
function applyViewport() {
  syncTyping();
  const vv = window.visualViewport;
  const root = document.documentElement.style;
  if (!vv) { root.removeProperty('--kb'); root.removeProperty('--vvh'); return; }
  const kb = keyboardInset({ innerHeight: window.innerHeight, vvHeight: vv.height, vvOffsetTop: vv.offsetTop });
  root.setProperty('--kb', kb + 'px');
  if (kb > 0) root.setProperty('--vvh', Math.round(vv.height) + 'px'); else root.removeProperty('--vvh');
}
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', applyViewport);
  window.visualViewport.addEventListener('scroll', applyViewport);
}
window.addEventListener('orientationchange', () => setTimeout(applyMode, 150));

$('sideToggle').addEventListener('click', () => {
  const c = document.body.classList.toggle('side-collapsed');
  $('sideToggle').textContent = c ? '채팅 펼치기' : '채팅 접기';
});

function setChatOnly(on) {
  if (on && isHost()) {
    toast('방장은 영상을 숨길 수 없습니다. 영상이 재생 상태의 기준이라서입니다');
    return;
  }
  chatOnly = on;
  document.body.classList.toggle('chatonly', on);
  $('chatOnlyBtn').textContent = on ? '영상 보이기' : '영상 숨기기';
  if (on) {
    if (player) player.pause();
  } else {
    ensurePlayer().then(() => follow(true)).catch(() => {});
  }
  renderAll();
}
$('chatOnlyBtn').addEventListener('click', () => setChatOnly(!chatOnly));

/* ── 접속자 ───────────────────────────────────────────────── */
function togglePeople() {
  const box = $('people');
  box.hidden = !box.hidden;
  if (!box.hidden) { $('nameInput').value = me.name; renderPeople(); }
}
$('peopleBtn').addEventListener('click', togglePeople);
$('ovMoreBtn').addEventListener('click', togglePeople);
document.addEventListener('pointerdown', (e) => {
  const box = $('people');
  if (!box.hidden && !box.contains(e.target) && !$('peopleBtn').contains(e.target) && !$('ovMoreBtn').contains(e.target)) box.hidden = true;
});
/** 닉네임 저장의 단일 경로: 저장, presence 갱신, 접속자 패널 입력칸 */
function applyName(name) {
  me.name = name;
  store.set('wps.name', name);
  $('nameInput').value = name;
  trackPresence();
  renderPeople();
}
function saveName() {
  const name = $('nameInput').value.trim().slice(0, 12);
  if (!name) return;
  applyName(name);
  toast('닉네임을 바꿨습니다');
}
$('nameSave').addEventListener('click', saveName);
$('nameInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') saveName(); });

function renderPeople() {
  const list = presence.length ? presence : [{ id: me.id, name: me.name, host: isHost() }];
  $('peopleCount').textContent = String(list.length);
  const ul = $('peopleList');
  ul.replaceChildren(...list
    .slice()
    .sort((a, b) => Number(b.host) - Number(a.host) || a.name.localeCompare(b.name, 'ko'))
    .map((p) => {
      const li = document.createElement('li');
      li.dataset.id = p.id;
      const n = document.createElement('span');
      n.className = 'n';
      n.textContent = (p.host ? '👑 ' : '') + p.name + (p.id === me.id ? ' (나)' : '');
      li.append(n);
      if (isHost() && p.id !== me.id) {
        const btn = document.createElement('button');
        btn.textContent = '방장 넘기기';
        btn.className = 'ghost pass-host';
        btn.addEventListener('click', () => { $('people').hidden = true; delegate(p); });
        li.append(btn);
      }
      return li;
    }));
}

/* ── 화면 갱신 ────────────────────────────────────────────── */
function hostIsGone(now) {
  if (isHost() || restoring) return false;
  // 방장이 한 번도 없던 방: presence 가 동기화됐는데 host 표시가 없고 state 도 없으면 2.5초 뒤 바로 방장 없음
  if (!hostState && presenceSynced && !presence.some((x) => x.host)) {
    if (!noHostSince) noHostSince = now;
    if (now - noHostSince > 2500) return true;
  } else noHostSince = 0;
  let hp = null;
  if (hostState && presenceSynced) {
    const present = presence.some((p) => p.id === hostState.hostId);
    if (present) { hp = true; hostAbsentSince = 0; }
    else {
      if (!hostAbsentSince) hostAbsentSince = now;
      hp = now - hostAbsentSince > 2500 ? false : null;
    }
  }
  return hostGone({ hostState, now, joinedAt, hostPresent: hp, limitMs: HOST_LIMIT });
}

function statusText(now, gone) {
  if (DEMO) return '지금 방송 ' + fmtTime(getMyT()) + ' (demo, scripted chat)';
  if (!hostState) return gone ? '방장이 없습니다' : '방장을 찾는 중...';
  const label = epLabel(hostState.videoId) || hostState.title || (hostState.videoId ? '영상' : '영상 없음');
  if (gone) return `방장 ${hostState.hostName} 님이 나갔습니다 | ${label} | ${fmtTime(hostState.pos)}`;
  if (isHost()) {
    const t = player ? player.getTime() : 0;
    const pl = player ? player.isPlaying() : false;
    return `👑 ${hostState.hostName} (나) | ${label} | ${fmtTime(t)} ${pl ? '▶' : '⏸'}`;
  }
  return `👑 ${hostState.hostName} | ${label} | ${fmtTime(expectedPos(hostState, now))} ${hostState.playing ? '▶' : '⏸'}`;
}

function currentExpected(now) {
  if (!hostState) return 0;
  return isHost() && player ? player.getTime() : expectedPos(hostState, now);
}

let lastGone = false;
function renderStatus() {
  const now = Date.now();
  const gone = hostIsGone(now);
  lastGone = gone;
  const text = statusText(now, gone);
  $('statusline').textContent = text;
  $('statusline').title = hostState ? hostState.title : '';
  $('coStatus').textContent = text;
  const url = hostState && hostState.videoId ? watchUrl(hostState.videoId, currentExpected(now)) : '';
  for (const id of ['openApp', 'openAppBig']) {
    const a = $(id);
    if (url) a.href = url; else a.removeAttribute('href');
  }
  $('takeBtn').hidden = DEMO || !(gone && !isHost());
  $('peopleCount').textContent = String(presence.length || 1);
}

/** 지금 방장 화면에 맞춰져 있는가(같은 영상, 3초 이내, 재생 여부 같음, 따라가기 켜짐) */
function isSynced(now) {
  if (!player || !hostState || isHost() || !autoFollow) return false;
  return player.getVideoId() === hostState.videoId
    && Math.abs(player.getTime() - expectedPos(hostState, now)) <= 3
    && player.isPlaying() === hostState.playing;
}

function renderControls() {
  const guest = !!hostState && !isHost();
  const sb = $('syncBtn');
  sb.hidden = !guest || chatOnly;
  const synced = isSynced(Date.now());
  sb.textContent = synced ? '✓ 맞춰짐' : '다시 맞추기';
  sb.classList.toggle('primary', !synced);
  sb.classList.toggle('ghost', synced);
  $('followBtn').hidden = !guest || chatOnly;
  $('followBtn').textContent = autoFollow ? '자동 따라가기 켜짐' : '자동 따라가기 꺼짐';
  $('followBtn').setAttribute('aria-pressed', String(autoFollow));
  $('openApp').hidden = !(hostState && hostState.videoId);
  renderHostTools();
}

function renderHostTools() {
  const box = $('hostTools');
  box.hidden = !isHost();
  if (!isHost()) return;
  const wrap = $('episodes');
  const cur = player ? player.getVideoId() : null;
  if (wrap.childElementCount !== EPISODES.length) {
    wrap.replaceChildren(...EPISODES.map((ep) => {
      const b = document.createElement('button');
      b.className = 'ep';
      b.type = 'button';
      b.dataset.id = ep.videoId;
      b.textContent = ep.label;
      b.addEventListener('click', () => hostLoad(ep.videoId));
      return b;
    }));
  }
  for (const b of wrap.children) b.classList.toggle('active', b.dataset.id === cur);
}

function renderAll() { renderStatus(); renderControls(); renderPeople(); }

$('urlForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const id = parseYouTubeId($('urlInput').value);
  if (!id) { toast('유튜브 주소나 영상 ID를 알아보지 못했습니다'); return; }
  $('urlInput').value = '';
  hostLoad(id);
});

$('syncBtn').addEventListener('click', () => {
  if (!autoFollow) setAutoFollow(true);          // 꺼져 있었으면 "다시 맞추기" 가 따라가기도 켠다
  follow(true);
});
$('followBtn').addEventListener('click', () => {
  setAutoFollow(!autoFollow);
  if (autoFollow) follow(true);
});
$('takeBtn').addEventListener('click', () => takeOver());
for (const id of ['openApp', 'openAppBig']) {
  $(id).addEventListener('pointerdown', () => {
    const a = $(id);
    if (hostState && hostState.videoId) a.href = watchUrl(hostState.videoId, currentExpected(Date.now()));
  });
}

/* join=1 링크도 같은 큰 버튼(#playHint)으로 맞춘다. 별도의 첫 터치 동작은 두지 않는다. */

for (const evt of ['pointerdown', 'keydown']) {
  document.addEventListener(evt, () => { if (!gestured) { gestured = true; gestureAt = Date.now(); } }, true);
}

/* ── 1초 틱: 상태 줄, 탐색 감지 ─────────────────────────── */
function tick() {
  const now = Date.now();
  // "재생된 적 있음" 은 첫 제스처 이후에 2초 넘게 이어진 재생만 센다
  if (player && player.isPlaying()) { if (!playStart) playStart = now; } else playStart = 0;
  if (gestured && playStart && now - Math.max(playStart, gestureAt) > 2000) everPlayed = true;
  if (player) {
    const t = player.getTime();
    // busy 가 방금 풀린 틱(목표 위치에 닿은 순간)의 점프는 앱 명령의 결과다. 사용자 탐색으로 읽지 않는다.
    const busy = player.busy();
    const settling = wasBusy && !busy;
    wasBusy = busy;
    const cmdSince = lastPos != null && player.lastCmdAt() >= lastPosAt - 50;   // 지난 틱 이후 앱이 명령을 냈다
    if (lastPos != null && !busy && !settling && !cmdSince) {
      const exp = lastPos + (player.isPlaying() ? (now - lastPosAt) / 1000 : 0);
      if (Math.abs(t - exp) > 2) onUserSeek();
    }
    lastPos = t;
    lastPosAt = now;
    if (isHost() && player.getVideoId() !== lastSentVideo) sendState();
  }
  renderHint();
  maybeSendRecap();
  renderStatus();
  renderControls();
}
/** 방장이 재생 중인데 내 플레이어가 멈춰 있으면 플레이어 위에 큰 버튼을 띄운다.
 *  아직 한 번도 재생한 적 없는 사람(모바일 자동재생 차단), 차단 이벤트를 받은 사람, 4초 넘게 못 시작한 사람이 대상이다. */
function renderHint() {
  const now = Date.now();
  const wants = !!player && !!hostState && !isHost() && !chatOnly && hostState.playing && !player.isPlaying();
  // 버퍼링으로 잠깐 멈춘 순간마다 버튼이 깜빡이지 않도록, 1.5초 넘게 멈춰 있을 때만 띄운다(차단 이벤트는 즉시)
  if (!wants) notPlayingSince = 0; else if (!notPlayingSince) notPlayingSince = now;
  const settled = autoplayBlocked || (notPlayingSince && now - notPlayingSince > 1500);
  const stuck = wants && followedAt && now - followedAt > 4000;
  const show = wants && settled && (!everPlayed || autoplayBlocked || stuck);
  const btn = $('playHint');
  btn.hidden = !show;
  if (show) {
    const label = epLabel(hostState.videoId) || hostState.title || '영상';
    btn.replaceChildren(
      Object.assign(document.createElement('b'), { textContent: '▶ 방장 화면 따라 보기' }),
      Object.assign(document.createElement('small'), {
        textContent: `${hostState.hostName} | ${label} | ${fmtTime(expectedPos(hostState, now))}` }),
    );
  }
}
$('playHint').addEventListener('click', () => {
  if (!player || !hostState || isHost()) return;
  everPlayed = true;
  setAutoFollow(true);
  follow(true);              // 사용자 탭이라 자동재생 제한을 통과한다
  player.play();
  renderHint();
});

function onUserSeek() {
  if (isHost()) { hostReady = true; sendState(); return; }
  if (autoFollow && hostState) {
    setAutoFollow(false);
    toast('직접 이동해서 자동 따라가기를 껐습니다');
  }
}
setInterval(tick, 1000);
setInterval(() => { if (isHost()) sendState(); }, 3000);

/* ── 폰 잠금 후 복귀 등에서 연결 되살리기 ─────────────── */
let hiddenAt = 0;
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { hiddenAt = Date.now(); return; }
  if (!ready || Date.now() - hiddenAt > 20000) setupChannel();
});
window.addEventListener('online', () => { if (!ready) setupChannel(); });

/* ── 새로 온 사람 알림과 지금까지 요약 ────────────────────────
   내용 줄은 미리 만든 파일(recaps/<videoId>.json), 반응 줄은 받은 채팅과 react 를 브라우저가 직접 집계한다.
   방장 브라우저만 새로 온 사람을 모아 gap(기본 5분) 간격으로 recap 이벤트를 보낸다. */
const RECAP_GAP = params.has('recapgap') ? Number(params.get('recapgap')) : (cfg.RECAP_INTERVAL_MS || 300000);
const reactLog = [];                 // { emoji, ts } 최근 500개
let lastRecapAt = 0;                 // 마지막 recap 시각(받은 것 포함). 새 방장이 이어받는다
const seenUids = new Set();          // 방장이 이번 세션에서 이미 본 사람
const pendingNew = new Map();        // uid -> { id, name } 아직 알리지 않은 새 사람
let trackingNew = false;
let recapSending = false;
let lastLocalRecapAt = 0;

function noteReact(emoji) {
  reactLog.push({ emoji, ts: Date.now() });
  if (reactLog.length > 500) reactLog.splice(0, reactLog.length - 500);
}
function noteRecapAt(at) { lastRecapAt = Math.max(lastRecapAt, Math.min(at, Date.now())); }

/** 카드 내용: 백엔드 /ask 의 요약(내 시각까지) + 마지막 요약 이후의 반응 */
async function buildRecapCard(names) {
  const now = Date.now();
  const videoId = getVideoIdNow();
  const label = epLabel(videoId);
  const pos = getMyT();
  let content = '';
  try {
    const r = await ai.ask(ai.RECAP_Q);
    content = r && r.answerable !== false ? String(r.answer_ko || '') : '';
  } catch { content = ''; }
  if (!content) content = '요약을 가져오지 못했어요.';
  const reactions = formatReactions(summarizeReactions({ msgs, reacts: reactLog, sinceTs: lastRecapAt }));
  return { id: crypto.randomUUID(), at: now, names, label, pos, content, reactions };
}

function recapMsg(rc, local) {
  const head = rc.names.length ? `🆕 ${rc.names.join(', ')}님이 들어왔어요` : '📌 지금까지 요약';
  const m = { id: rc.id, name: '시청회', text: head, vt: null, ts: rc.at, kind: 'recap', recap: rc };
  if (local) m.local = true;
  return m;
}

function addRecapMsg(m) {
  if (seen.has(m.id)) return;
  seen.add(m.id);
  msgs = mergeMsgs(msgs, [m], CHAT_MAX);
  addToLog(m, !!m.local);
  addToOverlay(m);
  if (!m.local) noteRecapAt(m.recap.at);
}

function onRecap(payload) {
  const rc = sanitizeRecap(payload);
  if (!rc || seen.has(rc.id)) return;
  addRecapMsg(recapMsg(rc, false));
}

/** 방장: presence 에서 이번 세션에 처음 보는 사람을 대기 명단에 넣고, 나간 사람은 뺀다 */
function trackNewcomers() {
  if (!isHost()) return;
  if (!trackingNew) {                         // 방장이 된 시점에 이미 있던 사람은 알리지 않는다
    trackingNew = true;
    seenUids.clear(); pendingNew.clear();
    seenUids.add(me.uid);
    for (const p of presence) seenUids.add(p.uid);
    return;
  }
  for (const p of presence) {
    if (p.id === me.id || seenUids.has(p.uid)) continue;
    seenUids.add(p.uid);
    pendingNew.set(p.uid, { id: p.id, name: p.name });
  }
  for (const [uid, v] of pendingNew) if (!presence.some((p) => p.id === v.id)) pendingNew.delete(uid);
  maybeSendRecap();
}

function maybeSendRecap() {
  return;      // 방장 자동 요약은 끈다: 방장 시각 기준 요약이 뒤처진 사람에게 스포일러가 된다
  // eslint-disable-next-line no-unreachable
  if (!isHost() || !hostReady || recapSending) return;
  for (const [uid, v] of pendingNew) if (presenceSynced && !presence.some((p) => p.id === v.id)) pendingNew.delete(uid);
  if (!recapDue({ now: Date.now(), lastAt: lastRecapAt, gap: RECAP_GAP, pending: pendingNew.size })) return;
  sendRecap();
}

async function sendRecap() {
  recapSending = true;
  try {
    const names = [...pendingNew.values()].map((v) => v.name).slice(0, 10);
    pendingNew.clear();
    const rc = await buildRecapCard(names);
    addRecapMsg(recapMsg(rc, false));
    await sendEv('recap', rc);
  } finally { recapSending = false; }
}

/** 누구나: 지금까지 요약을 내 화면에만 넣는다(방송하지 않음). 연타는 10초에 한 번 */
$('recapBtn').addEventListener('click', async () => {
  const now = Date.now();
  if (now - lastLocalRecapAt < 10000) { toast('방금 요약을 넣었어요. 잠시 뒤에 다시 눌러 주세요'); return; }
  lastLocalRecapAt = now;
  $('people').hidden = true;
  $('ai').open = true;
  ai.ask(ai.RECAP_Q);  // summary up to the broadcast time, shown in the AI panel with time chips
});

/* ── 첫 접속 온보딩: 닉네임 입력 → 화면 안내(스포트라이트) ───────── */
let suggestedName = randomName();
function openNickModal() {
  $('nickModal').hidden = false;
  $('nickInput').value = '';
  $('nickInput').placeholder = suggestedName;
  $('nickErr').hidden = true;
  $('nickInput').focus();
}
$('nickDice').addEventListener('click', () => {
  suggestedName = randomName();
  $('nickInput').value = suggestedName;
  $('nickInput').placeholder = suggestedName;
  $('nickErr').hidden = true;
  $('nickInput').focus();
});
$('nickForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = $('nickInput').value.trim().slice(0, 12);
  if (!name) { $('nickErr').hidden = false; $('nickInput').focus(); return; }
  applyName(name);
  $('nickModal').hidden = true;
  $('nickInput').blur();
  setTimeout(() => startTour(), 250);           // 키보드가 내려가 화면 크기가 안정된 뒤에 시작한다
});

// 단계마다 후보 대상 묶음을 순서대로 본다. 처음으로 "지금 화면에 보이는" 묶음이 대상이다. 없으면 그 단계를 건너뛴다.
const TOUR_STEPS = [
  { groups: [['#statusline']], title: '방장 화면', desc: '👑 방장이 지금 보는 회차와 시간이 여기 떠요.' },
  { groups: [['#syncBtn'], ['#playHint'], ['#statusline']], title: '방장 화면에 맞추기',
    desc: '늦게 와도 이 버튼 하나면 방장과 같은 장면으로 이동해요. 자동 따라가기는 기본으로 켜져 있어요.' },
  { groups: [['#composer'], ['#ovCtl']], title: '채팅과 반응',
    desc: '메시지는 보낸 순간의 영상 시간과 함께 떠요. 이모지 버튼으로 반응을 날려 보세요.' },
  { groups: [['#peopleBtn'], ['#ovMoreBtn']], title: '접속자와 설정',
    desc: '닉네임 바꾸기, 방장 넘기기, 유튜브 앱에서 열기가 여기 있어요. 놓친 내용은 [지금까지 요약]으로 볼 수 있어요.' },
  { groups: [['#fsBtn', '#chatOnlyBtn'], ['#ovChatBtn']], title: '보는 방법 고르기',
    desc: '⛶ 영상 위에 채팅 띄우기(폰은 가로로 돌리면 자동), 영상 숨기기는 TV나 유튜브 앱으로 볼 때. 💬로 채팅을 보이기, 흐리게, 숨기기.' },
];
function visibleRect(el) {
  const r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0 || getComputedStyle(el).visibility === 'hidden') return null;
  if (r.bottom < 0 || r.right < 0 || r.top > window.innerHeight || r.left > window.innerWidth) return null;
  return r;
}
/** 단계의 대상 사각형(보이는 요소들의 합집합). 보이는 대상이 없으면 null */
function stepRect(step) {
  for (const group of step.groups) {
    const rects = group.map((sel) => document.querySelector(sel)).filter(Boolean).map(visibleRect).filter(Boolean);
    if (rects.length) {
      return {
        left: Math.min(...rects.map((r) => r.left)), top: Math.min(...rects.map((r) => r.top)),
        right: Math.max(...rects.map((r) => r.right)), bottom: Math.max(...rects.map((r) => r.bottom)),
      };
    }
  }
  return null;
}
let tour = null;     // { steps, i }
function placeTour() {
  if (!tour) return;
  const rect = stepRect(tour.steps[tour.i]);
  if (!rect) return;
  const pad = 6;
  const spot = $('tourSpot').style;
  spot.left = rect.left - pad + 'px'; spot.top = rect.top - pad + 'px';
  spot.width = rect.right - rect.left + pad * 2 + 'px'; spot.height = rect.bottom - rect.top + pad * 2 + 'px';
  const tip = $('tourTip');
  const vw = window.innerWidth, vh = window.innerHeight;
  const th = tip.offsetHeight, tw = tip.offsetWidth;
  const below = rect.bottom + pad + 10 + th <= vh - 8;
  const above = rect.top - pad - 10 - th >= 8;
  let top, left;
  const cx = (rect.left + rect.right) / 2;
  const cy = (rect.top + rect.bottom) / 2;
  if (below) { top = rect.bottom + pad + 10; left = Math.max(12, Math.min(vw - tw - 12, cx - tw / 2)); }
  else if (above) { top = rect.top - pad - 10 - th; left = Math.max(12, Math.min(vw - tw - 12, cx - tw / 2)); }
  else if (rect.left - pad - 10 - tw >= 8) {            // 위아래가 모자라면(가로 화면) 대상 왼쪽에 둔다
    left = rect.left - pad - 10 - tw; top = Math.max(8, Math.min(vh - th - 8, cy - th / 2));
  } else if (rect.right + pad + 10 + tw <= vw - 8) {
    left = rect.right + pad + 10; top = Math.max(8, Math.min(vh - th - 8, cy - th / 2));
  } else { top = Math.max(8, Math.min(vh - th - 8, rect.top > vh / 2 ? 8 : vh - th - 8)); left = Math.max(12, Math.min(vw - tw - 12, cx - tw / 2)); }
  tip.style.top = Math.round(top) + 'px';
  tip.style.left = Math.round(left) + 'px';
}
function showTourStep() {
  // 지금 보이지 않는 대상의 단계는 건너뛴다
  while (tour && tour.i < tour.steps.length && !stepRect(tour.steps[tour.i])) tour.i++;
  if (!tour || tour.i >= tour.steps.length) { endTour(); return; }
  const vis = tour.steps.map((st) => !!stepRect(st));
  const total = vis.filter(Boolean).length;
  const pos = vis.slice(0, tour.i + 1).filter(Boolean).length;
  const step = tour.steps[tour.i];
  $('tourTitle').textContent = step.title;
  $('tourDesc').textContent = step.desc;
  $('tourCount').textContent = `${pos}/${total}`;
  $('tourNext').textContent = pos === total ? '시작' : '다음';
  $('tour').hidden = false;
  placeTour();
}
function startTour() {
  $('people').hidden = true;
  tour = { steps: TOUR_STEPS, i: 0 };
  showTourStep();
}
function endTour() {
  tour = null;
  $('tour').hidden = true;
  store.set('wps.onboarded', '1');
  renderHint();
}
$('tourNext').addEventListener('click', () => { if (tour) { tour.i++; showTourStep(); } });
$('tourSkip').addEventListener('click', endTour);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && tour) endTour(); });
window.addEventListener('resize', () => { if (tour) placeTour(); });
$('tourAgain').addEventListener('click', () => { startTour(); });

/* ── 시작 ─────────────────────────────────────────────── */
applyMode();
renderOv();
document.body.classList.toggle('chatonly', chatOnly);
$('chatOnlyBtn').textContent = chatOnly ? '영상 보이기' : '영상 숨기기';
renderAll();

/* ── AI manager, 스포일러 방패, 친구 위치 ───────────────────────── */
const shield = createShield({
  getT: getMyT, getVideoId: getVideoIdNow,
  onUpdate: () => refreshLocks(),
});
const ai = createAIPanel({ mount: $('ai'), getT: getMyT, getVideoId: getVideoIdNow, seekTo: seekMy });
let demoFriends = [];
function renderFriendChips() {
  const list = DEMO
    ? demoFriends
    : presence.filter((x) => x.id !== me.id && x.vt != null).map((x) => ({ name: x.name, t: x.vt }));
  ai.renderFriends([]);  // TV mode: no per-friend positions
}
// 1초마다: 내 시각 기준으로 잠금을 로컬에서 다시 판정한다. 5초마다: 내 위치를 presence 로 알린다
setInterval(() => {
  if (DEMO) demoT = DEMO_T0 + Math.floor((Date.now() - demoStart) / 1000);
  refreshLocks();
}, 1000);
setInterval(() => { if (!DEMO && ready) trackPresence(); }, 5000);

async function startDemo() {
  document.body.classList.add('demo');
  $('demoBanner').hidden = false;
  $('status').title = 'Demo mode';
  $('send').disabled = true;
  $('text').placeholder = 'Chat is scripted in demo mode';
  $('text').disabled = true;
  $('ai').open = true;
  const [chat, friends] = await Promise.all([
    fetch('/static/demo/chat_log.json', { cache: 'no-store' }).then((r) => r.json()).catch(() => []),
    fetch('/static/demo/friends.json').then((r) => r.json()).catch(() => []),
  ]);
  demoFriends = (Array.isArray(friends) ? friends : [])
    .map((f) => ({ name: String(f.name || '').slice(0, 12), t: toSec(f.t) })).filter((f) => f.name && f.t != null);
  renderFriendChips();
  const list = (Array.isArray(chat) ? chat : []).map((c, i) => ({
    id: 'demo-' + String(c.id), name: String(c.nick || '').slice(0, 12), text: String(c.text || '').slice(0, 120),
    vt: toSec(c.posted_at), ts: Date.now() - (chat.length - i) * 1000,
  })).filter((m) => m.id && m.text);
  for (const m of list) seen.add(m.id);
  msgs = mergeMsgs(msgs, list, CHAT_MAX);
  demoStart = Date.now();
  shield.request(list);
  rerenderLog();
  if (!chatOnly) {
    try { const p = await ensurePlayer(); p.load(DEMO_VIDEO, DEMO_T0, true); } catch { /* clock still runs */ }
  }
}

if (DEMO) {
  startDemo();
} else {
  $('ai').open = true;
  setupChannel();
  if (!chatOnly) ensurePlayer().catch(() => {});
  if (store.get('wps.onboarded') !== '1') openNickModal();     // 모달이 떠 있어도 연결, 플레이어, 방장 상태 수신은 뒤에서 그대로 진행된다
}     // 모달이 떠 있어도 연결, 플레이어, 방장 상태 수신은 뒤에서 그대로 진행된다

// 테스트와 점검용 읽기 창구
window.__wps = {
  get hostState() { return hostState; },
  get isHost() { return isHost(); },
  get msgs() { return msgs; },
  get presence() { return presence; },
  get ready() { return ready; },
  get player() { return player; },
  me,
  startTour: () => startTour(),
  // 시험용: 임의 payload 보내기, 연결 끊기/다시 붙이기
  rawSend: (event, payload) => channel.send({ type: 'broadcast', event, payload }),
  dropChannel() { clearTimeout(reconnectTimer); const ch = channel; channel = null; ready = false; supabase.removeChannel(ch); },
  reconnect: () => setupChannel(),
  delegateTo: (id) => delegate(presence.find((x) => x.id === id) || { id, name: '상대' }),
};
