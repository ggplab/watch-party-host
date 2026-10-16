// 순수 함수만 모았다. 브라우저에서는 window.syncCore, Node에서는 require 로 쓴다.
// 시간은 항상 "받는 쪽 시계"로 계산한다(방장 기기와 시계가 어긋나도 맞도록).

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.syncCore = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const DRIFT_SECONDS = 3;       // 이 이상 벌어지면 탐색한다
  const HOST_GONE_MS = 10000;    // 상태가 이만큼 안 오면 방장이 없는 것으로 본다

  /** 방장 상태가 받은 순간부터 흐른 만큼 더한 "지금 있어야 할 위치"(초) */
  function expectedPos(state, now) {
    if (!state) return 0;
    const pos = Number(state.pos) || 0;
    if (!state.playing) return pos;
    const elapsed = (now - state.receivedAt) / 1000;
    return pos + (elapsed > 0 ? elapsed : 0);
  }

  const MAX_TERM = 1e9;
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const isUuid = (v) => typeof v === 'string' && UUID_RE.test(v);
  const isUint = (v, max) => Number.isInteger(v) && v >= 0 && v <= max;

  /** 새로 온 상태를 받아들일지. cur 은 지금 알고 있는 방장 상태(없으면 null).
   *  범위 밖 값(term 1e100, hostId "!" 등)은 보정하지 않고 거부한다. */
  function acceptState(cur, inc) {
    if (!inc || typeof inc !== 'object') return false;
    if (!isUint(inc.term, MAX_TERM) || !isUuid(inc.hostId)) return false;
    if (inc.seq !== undefined && !isUint(inc.seq, Number.MAX_SAFE_INTEGER)) return false;
    if (!cur) return true;
    if (inc.term > cur.term) return true;
    if (inc.term < cur.term) return false;
    if (inc.hostId === cur.hostId) {
      // 같은 seq 를 다시 받으면(중복 전달) 시간 기준이 뒤로 밀리므로 거부한다
      if (Number.isFinite(inc.seq) && Number.isFinite(cur.seq) && inc.seq <= cur.seq) return false;
      return true;
    }
    return inc.hostId < cur.hostId;          // 동시에 방장을 누른 경우: 작은 id가 이긴다
  }

  /** 남이 보낸 방장 상태를 검증하고 모양을 다시 만든다. 못 믿으면 null */
  function sanitizeState(p) {
    if (!p || typeof p !== 'object') return null;
    if (!isUint(p.term, MAX_TERM) || !isUuid(p.hostId)) return null;
    if (!isUint(p.seq === undefined ? 0 : p.seq, Number.MAX_SAFE_INTEGER)) return null;
    let videoId = null;
    if (p.videoId != null) {
      videoId = parseYouTubeId(p.videoId);
      if (!videoId || typeof p.videoId !== 'string') return null;
    }
    if (p.pos !== undefined && !(typeof p.pos === 'number' && Number.isFinite(p.pos) && p.pos >= 0 && p.pos < 1e7)) return null;
    return {
      term: p.term,
      hostId: p.hostId,
      hostName: typeof p.hostName === 'string' ? p.hostName.slice(0, 12) || '익명' : '익명',
      videoId,
      title: typeof p.title === 'string' ? p.title.slice(0, 200) : '',
      pos: p.pos || 0,
      playing: p.playing === true,
      seq: p.seq === undefined ? 0 : p.seq,
    };
  }

  /** 채팅 메시지 payload 검증(id 는 문자열 64자 이하, ts 는 유한한 수). 못 믿으면 null */
  function sanitizeMsg(p) {
    if (!p || typeof p !== 'object') return null;
    if (typeof p.id !== 'string' || !p.id || p.id.length > 64) return null;
    if (typeof p.text !== 'string' || !p.text.trim()) return null;
    if (p.name !== undefined && typeof p.name !== 'string') return null;
    if (!Number.isFinite(p.ts)) return null;
    if (p.kind === 'recap') {                       // 새로 온 사람 알림 카드(history 로도 전달된다)
      const rc = sanitizeRecap(p.recap);
      if (!rc) return null;
      return { id: p.id, name: String(p.name || '시청회').slice(0, 12), text: p.text.slice(0, 120), vt: null, ts: p.ts, kind: 'recap', recap: rc };
    }
    return {
      id: p.id,
      name: String(p.name || '익명').slice(0, 12),
      text: p.text.slice(0, 120),
      vt: typeof p.vt === 'number' && Number.isFinite(p.vt) && p.vt >= 0 && p.vt < 1e7 ? p.vt : null,
      ts: p.ts,
    };
  }

  /** history payload: 내게 온 것이고 배열이면 최대 100개만 돌려준다 */
  function sanitizeHistory(p, myId) {
    if (!p || typeof p !== 'object' || p.to !== myId || !Array.isArray(p.msgs)) return null;
    return p.msgs.slice(-100).map(sanitizeMsg).filter(Boolean);
  }

  /** react payload: 이모지 문자열(16자 이하)과 이름 문자열 */
  function sanitizeReact(p, isEmoji) {
    if (!p || typeof p !== 'object' || typeof p.emoji !== 'string' || p.emoji.length > 16) return null;
    if (!isEmoji(p.emoji)) return null;
    return { emoji: p.emoji.trim(), name: typeof p.name === 'string' ? p.name.slice(0, 12) : '' };
  }

  /** recap 이벤트 payload 검증. names 최대 10명 각 12자, 문자열 길이 제한. 못 믿으면 null */
  function sanitizeRecap(p) {
    if (!p || typeof p !== 'object') return null;
    if (typeof p.id !== 'string' || !p.id || p.id.length > 64 || !Number.isFinite(p.at)) return null;
    if (p.names !== undefined && !Array.isArray(p.names)) return null;
    const names = (p.names || []).filter((n) => typeof n === 'string' && n.trim()).slice(0, 10).map((n) => n.slice(0, 12));
    for (const k of ['label', 'content', 'reactions']) if (p[k] !== undefined && p[k] !== null && typeof p[k] !== 'string') return null;
    if (p.pos != null && !(typeof p.pos === 'number' && Number.isFinite(p.pos) && p.pos >= 0 && p.pos < 1e7)) return null;
    return {
      id: p.id, at: p.at, names,
      label: String(p.label || '').slice(0, 20),
      pos: p.pos == null ? null : p.pos,
      content: String(p.content || '').slice(0, 400),
      reactions: String(p.reactions || '').slice(0, 300),
    };
  }

  /** 요약 파일에서 방장 위치에 맞는 줄을 고른다. recap 이 null(파일 없음)이면 null.
   *  pos 가 step(기본 300초) 미만이면 start, 아니면 pos 이하인 마지막 point(파일 끝을 넘으면 마지막 point) */
  function pickRecap(recap, pos) {
    if (!recap || !Array.isArray(recap.points) || !recap.points.length) return null;
    const step = Number.isFinite(recap.step) && recap.step > 0 ? recap.step : 300;
    const p = Number(pos) || 0;
    if (p < step) return { kind: 'start', text: '아직 막 시작했어요' };
    let best = null;
    for (const pt of recap.points) {
      if (pt && Number.isFinite(pt.t) && typeof pt.summary === 'string' && pt.t <= p && (!best || pt.t > best.t)) best = pt;
    }
    return best ? { kind: 'point', t: best.t, text: best.summary } : { kind: 'start', text: '아직 막 시작했어요' };
  }

  const STOPWORDS = new Set(['ㅋㅋ', 'ㅎㅎ', 'ㅋㅋㅋ', 'ㅎㅎㅎ', '진짜', '너무', '근데', '이거', '그냥', '저거', '그거', '약간', '완전',
    '아니', '이게', '저게', '그게', '지금', '여기', '우리', '이제', '정말', '그리고', '그런데', '하는', '해서', 'ㅇㅇ', 'ㄹㅇ']);
  const PARTICLES = '은는이가을를의에도로와과만';
  /** 메시지 글에서 센 만한 말(2글자 이상, 조사 단순 제거, 불용어 제외)을 뽑는다 */
  function tokenize(text) {
    const out = [];
    for (let t of String(text || '').split(/[^\p{L}\p{N}]+/u)) {
      if (!t) continue;
      if (/^[ㄱ-ㅎㅏ-ㅣ]+$/.test(t)) continue;                                   // ㅋㅋㅋ 같은 자음 모음만의 토큰
      if (t.length >= 3 && PARTICLES.includes(t[t.length - 1])) t = t.slice(0, -1);
      if (t.length < 2 || STOPWORDS.has(t)) continue;
      out.push(t);
    }
    return out;
  }

  /** 반응 집계: sinceTs 이후의 채팅 msgs 와 react 로그. 순수 함수 */
  function summarizeReactions({ msgs, reacts, sinceTs }) {
    const chat = (msgs || []).filter((m) => m && !m.kind && !m.local && m.ts > (sinceTs || 0));
    const emojiCount = new Map();
    for (const r of reacts || []) if (r && r.ts > (sinceTs || 0)) emojiCount.set(r.emoji, (emojiCount.get(r.emoji) || 0) + 1);
    const emojis = [...emojiCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
    const wc = new Map();
    for (const m of chat) for (const t of tokenize(m.text)) wc.set(t, (wc.get(t) || 0) + 1);
    const words = [...wc.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([w]) => w);
    const last = chat.length ? chat.reduce((a, b) => (b.ts >= a.ts ? b : a)) : null;
    return { chatCount: chat.length, emojis, words, recent: last ? { name: last.name, text: last.text.slice(0, 40) } : null };
  }

  /** "채팅 48개 | 😂 23 😱 9 | 많이 나온 말: 배신, 화이트팀 | 최근: 영희 '와 이걸 배신하네'" */
  function formatReactions(sum) {
    const parts = [`채팅 ${sum.chatCount}개`];
    if (sum.emojis.length) parts.push(sum.emojis.map(([e, n]) => `${e} ${n}`).join(' '));
    if (sum.words.length) parts.push('많이 나온 말: ' + sum.words.join(', '));
    parts.push(sum.recent ? `최근: ${sum.recent.name} '${sum.recent.text}'` : '아직 채팅이 없어요');
    return parts.join(' | ');
  }

  /** 새로 온 사람 알림을 지금 보낼 때인가: 대기자가 있고 마지막 송신 뒤 gap 이 지났다 */
  function recapDue({ now, lastAt, gap, pending }) {
    return pending > 0 && (!lastAt || now - lastAt >= gap);
  }

  /** 가상 키보드가 가린 아래쪽 높이(px) */
  function keyboardInset({ innerHeight, vvHeight, vvOffsetTop }) {
    if (![innerHeight, vvHeight, vvOffsetTop].every(Number.isFinite)) return 0;
    return Math.max(0, Math.round(innerHeight - vvHeight - vvOffsetTop));
  }

  /** 앱이 낸 명령과 사용자 조작을 구별하는 추적기. now 는 시계 함수 */
  function makeCmdTracker(now) {
    let pend = null;   // { kind, playing, pos, at, ttl }
    let lastAt = 0;
    return {
      /** 마지막으로 앱이 명령을 낸 시각 */
      lastCmdAt() { return lastAt; },
      /** kind: 'load' | 'seek' | 'play' | 'pause'. playing: 명령이 기대하는 재생 여부(없으면 null) */
      cmd(kind, { playing = null, pos = null } = {}) {
        lastAt = now();
        pend = { kind, playing, pos, at: lastAt, ttl: kind === 'load' ? 8000 : 1500 };
      },
      /** 재생 상태 변화가 사용자 조작인가. 명령이 기대한 결과와 같으면 앱 것, 다르면 사용자 것 */
      classifyState(playingNow) {
        if (!pend || now() - pend.at > pend.ttl) { pend = null; return 'user'; }
        if (pend.playing === null) return 'user';   // 탐색 명령은 재생 여부를 바꾸지 않으므로 바뀌었다면 사람이 한 것
        return pend.playing === playingNow ? 'app' : 'user';
      },
      /** 위치 점프를 앱 명령의 결과로 보고 무시할 시간대인가(목표 위치에 닿으면 끝) */
      busy(curTime, curPlaying) {
        if (!pend) return false;
        const age = now() - pend.at;
        if (age > 8000) { pend = null; return false; }
        if (pend.pos === null) return age < 1500;
        const target = pend.pos + (curPlaying ? age / 1000 : 0);
        if (Math.abs(curTime - target) <= 2.5) { pend = null; return false; }
        return true;
      },
    };
  }

  /** 내 플레이어를 방장 상태에 맞추려면 무엇을 할지. local = {videoId, pos} */
  function driftAction(state, local, now, manual) {
    if (!state || !state.videoId) return { action: 'none', pos: 0 };
    const pos = expectedPos(state, now);
    if (!local || local.videoId !== state.videoId) return { action: 'load', pos };
    if (manual) return { action: 'seek', pos };         // 손으로 맞추기는 3초 기준 없이 항상 맞춘다
    if (Math.abs((Number(local.pos) || 0) - pos) > DRIFT_SECONDS) return { action: 'seek', pos };
    return { action: 'none', pos };
  }

  const ID_RE = /^[A-Za-z0-9_-]{11}$/;

  /** 유튜브 주소나 ID 에서 11자 영상 ID 를 뽑는다. 못 뽑으면 null */
  function parseYouTubeId(input) {
    if (typeof input !== 'string') return null;
    const s = input.trim();
    if (!s) return null;
    if (ID_RE.test(s)) return s;
    let url;
    try { url = new URL(/^https?:\/\//i.test(s) ? s : 'https://' + s); } catch { return null; }
    const host = url.hostname.replace(/^(www|m|music)\./, '');
    let id = null;
    if (host === 'youtu.be') id = url.pathname.split('/')[1];
    else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
      const parts = url.pathname.split('/').filter(Boolean);
      if (parts[0] === 'watch') id = url.searchParams.get('v');
      else if (['shorts', 'embed', 'live', 'v'].includes(parts[0])) id = parts[1];
    }
    return id && ID_RE.test(id) ? id : null;
  }

  /** 초 -> 32:15 / 1:41:02 */
  function fmtTime(sec) {
    const t = Number.isFinite(sec) && sec > 0 ? Math.floor(sec) : 0;
    const h = Math.floor(t / 3600);
    const m = Math.floor((t % 3600) / 60);
    const s = t % 60;
    const ss = String(s).padStart(2, '0');
    return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
  }

  /** 유튜브 앱/브라우저로 그 위치부터 여는 주소 */
  function watchUrl(videoId, pos) {
    const base = 'https://www.youtube.com/watch?v=' + encodeURIComponent(videoId);
    const t = Math.floor(Number(pos) || 0);
    return t > 0 ? `${base}&t=${t}s` : base;
  }

  /** 방장이 사라졌는지. hostPresent: presence 에 방장이 있는가(동기화 전이면 null) */
  function hostGone({ hostState, now, joinedAt, hostPresent, limitMs }) {
    const limit = Number.isFinite(limitMs) ? limitMs : HOST_GONE_MS;
    if (!hostState) return now - (joinedAt || now) > limit;
    if (hostPresent === false) return true;
    return now - hostState.receivedAt > limit;
  }

  /** 채팅 기록 합치기: id 중복 제거, ts 순, 뒤에서 max 개만 */
  function mergeMsgs(cur, incoming, max) {
    const byId = new Map();
    for (const m of cur || []) if (m && m.id) byId.set(m.id, m);
    for (const m of incoming || []) {
      if (!m || typeof m.id !== 'string' || !m.id || !Number.isFinite(m.ts)) continue;
      if (byId.has(m.id)) continue;
      const copy = {
        id: m.id,
        name: String(m.name || '익명').slice(0, 12),
        text: String(m.text || '').slice(0, 120),
        vt: Number.isFinite(m.vt) ? m.vt : null,
        ts: m.ts,
      };
      if (m.kind === 'recap' && m.recap && typeof m.recap === 'object') { copy.kind = 'recap'; copy.recap = m.recap; }
      if (m.local) copy.local = true;
      byId.set(m.id, copy);
    }
    const all = [...byId.values()].sort((a, b) => a.ts - b.ts);
    return all.slice(-max);
  }

  return { DRIFT_SECONDS, HOST_GONE_MS, expectedPos, acceptState, sanitizeState, sanitizeMsg, sanitizeHistory,
           sanitizeReact, sanitizeRecap, pickRecap, tokenize, summarizeReactions, formatReactions, recapDue, keyboardInset, makeCmdTracker, isUuid, driftAction,
           parseYouTubeId, fmtTime, watchUrl, hostGone, mergeMsgs };
});
