// 플레이어 어댑터. 실제 YouTube IFrame 과 테스트용 가짜 플레이어가 같은 모양을 낸다.
//
//   const p = await createPlayer({ container, fake })
//   p.load(videoId, startSec, autoplay)  p.seek(sec)  p.play()  p.pause()
//   p.getTime()  p.getVideoId()  p.getTitle()  p.isPlaying()
//   p.onChange(cb)   cb({ type: 'state', playing, byUser })  |  cb({ type: 'error', code })
//
//   cb({ type: 'autoplayBlocked' })  소리 있는 자동재생이 막혔을 때

// 앱이 낸 명령(load/seek/play/pause)과 사용자 조작의 구별은 sync-core 의 makeCmdTracker 가 맡는다.
// 시간대 전체를 무시하지 않고, 명령이 기대한 결과와 같은 변화만 앱 것으로 본다.

function makeBase() {
  const tracker = window.syncCore.makeCmdTracker(() => Date.now());
  const listeners = [];
  return {
    tracker,
    onChange(cb) { listeners.push(cb); },
    emit(ev) { for (const cb of listeners) { try { cb(ev); } catch (e) { console.error(e); } } },
  };
}

/* ── 가짜 플레이어 ─────────────────────────────────────────── */
function createFake(container) {
  const base = makeBase();
  const box = document.createElement('div');
  box.className = 'fake-player';
  box.style.cssText = 'position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;'
    + 'justify-content:center;background:#10131a;color:#9fb4ff;font:600 14px/1.5 monospace;text-align:center;white-space:pre';
  container.append(box);

  let videoId = null;
  let basePos = 0;
  let startedAt = 0;
  let playing = false;
  let loadDelay = 0;
  let blockAutoplay = false;      // 시험용: 소리 있는 자동재생이 막힌 환경을 흉내 낸다

  const pos = () => (playing ? basePos + (Date.now() - startedAt) / 1000 : basePos);
  const render = () => { box.textContent = videoId ? `FAKE ${videoId}\n${pos().toFixed(1)}s ${playing ? 'PLAY' : 'PAUSE'}` : 'FAKE (no video)'; };
  setInterval(render, 250);
  render();

  const setPlaying = (next) => {
    if (next === playing) return;
    basePos = pos();
    playing = next;
    startedAt = Date.now();
    base.emit({ type: 'state', playing, byUser: base.tracker.classifyState(next) === 'user' });
  };
  const tryPlay = () => {
    if (blockAutoplay === 'blip') {               // 실제 유튜브처럼 잠깐 재생되다 정책에 막혀 멈춘다(차단 이벤트 없음)
      setPlaying(true);
      setTimeout(() => setPlaying(false), 300);
      return;
    }
    if (blockAutoplay) { base.emit({ type: 'autoplayBlocked' }); return; }
    setPlaying(true);
  };

  const api = {
    kind: 'fake',
    busy: () => base.tracker.busy(pos(), playing),
    lastCmdAt: () => base.tracker.lastCmdAt(),
    load(id, start = 0, autoplay = true) {
      base.tracker.cmd('load', { playing: !!autoplay, pos: Number(start) || 0 });
      videoId = id; basePos = Number(start) || 0; startedAt = Date.now();
      playing = false;                          // 조용히 멈춘 상태에서 시작한다
      if (loadDelay > 0) {                      // 실제 유튜브처럼 한참 0초에 머물다가 시작 위치로 뛴다
        const target = basePos; basePos = 0;
        setTimeout(() => { basePos = target; startedAt = Date.now(); if (autoplay) tryPlay(); render(); }, loadDelay);
        render();
        return;
      }
      if (autoplay) tryPlay();
      render();
    },
    seek(sec) { base.tracker.cmd('seek', { pos: Number(sec) || 0 }); basePos = Number(sec) || 0; startedAt = Date.now(); },
    play() { base.tracker.cmd('play', { playing: true }); if (videoId) tryPlay(); },
    pause() { base.tracker.cmd('pause', { playing: false }); setPlaying(false); },
    getTime() { return videoId ? pos() : 0; },
    getVideoId() { return videoId; },
    getTitle() { return videoId ? '가짜 영상 ' + videoId : ''; },
    isPlaying() { return playing; },
    onChange: base.onChange,
    destroy() { box.remove(); },
  };

  // 테스트가 "사람이 직접 조작한 것" 을 흉내 내는 손잡이
  window.__fp = {
    userPlay() { setPlaying(true); },
    userPause() { setPlaying(false); },
    userSeek(sec) { basePos = Number(sec) || 0; startedAt = Date.now(); },
    set blockAutoplay(v) { blockAutoplay = v; },
    set loadDelay(v) { loadDelay = Number(v) || 0; },
    pos, get playing() { return playing; }, get videoId() { return videoId; },
  };
  return api;
}

/* ── 실제 YouTube IFrame ───────────────────────────────────── */
let apiPromise = null;
function loadYouTubeApi() {
  if (apiPromise) return apiPromise;
  apiPromise = new Promise((resolve, reject) => {
    if (window.YT && window.YT.Player) return resolve(window.YT);
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => { if (prev) prev(); resolve(window.YT); };
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    s.onerror = () => { apiPromise = null; reject(new Error('youtube api blocked')); };
    document.head.append(s);
    setTimeout(() => { if (!(window.YT && window.YT.Player)) { apiPromise = null; reject(new Error('youtube api timeout')); } }, 15000);
  });
  return apiPromise;
}

async function createYouTube(container, muted, placeholderId) {
  const YT = await loadYouTubeApi();
  const base = makeBase();
  const mount = document.createElement('div');
  container.append(mount);

  let curId = null;
  let loadAt = 0;
  let playing = false;
  let wantPlay = false;          // 우리가 재생을 시켰는데 아직 시작 안 했으면 다시 눌러 준다
  let player;
  await new Promise((resolve) => {
    player = new YT.Player(mount, {
      width: '100%', height: '100%',
      // 영상 없이 만들면 빈 ID(/embed/?...)로 열려 유튜브가 '오류 2'를 띄운다.
      // 그래서 첫 회차를 자리표시로 걸어 둔다(재생하지 않고 썸네일만). 앱 쪽의 '선택된 영상'(curId)은 여전히 없음이다.
      ...(placeholderId ? { videoId: placeholderId } : {}),
      playerVars: { playsinline: 1, fs: 0, rel: 0, modestbranding: 1, enablejsapi: 1,
                    origin: location.origin },
      events: {
        onReady: resolve,
        onStateChange(e) {
          const st = e.data;
          if (st === 3) return;                         // 버퍼링은 재생 여부를 바꾸지 않는다
          const next = st === 1;
          if (next === playing) return;
          playing = next;
          const byUser = base.tracker.classifyState(next) === 'user';
          if (byUser && !next) wantPlay = false;        // 사람이 멈췄다. 재생 재시도를 취소한다
          base.emit({ type: 'state', playing, byUser });
        },
        onError(e) { if (curId) base.emit({ type: 'error', code: e.data }); },   // 자리표시 영상의 오류는 알리지 않는다
        onAutoplayBlocked() { base.emit({ type: 'autoplayBlocked' }); },
      },
    });
  });
  if (muted) player.mute();       // 시험용: 음소거해야 헤드리스에서 자동재생이 열린다
  // 임베드 iframe 이 컨테이너를 꽉 채우도록
  const frame = container.querySelector('iframe');
  if (frame) frame.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;border:0';

  const timeNow = () => { try { return player.getCurrentTime() || 0; } catch { return 0; } };
  return {
    kind: 'youtube',
    busy: () => base.tracker.busy(timeNow(), playing),
    lastCmdAt: () => base.tracker.lastCmdAt(),
    load(id, start = 0, autoplay = true) {
      const startSeconds = Math.max(0, Number(start) || 0);
      base.tracker.cmd('load', { playing: !!autoplay, pos: startSeconds });
      curId = id;
      loadAt = Date.now();
      playing = false;                               // 로딩 중 중간 상태가 사용자 조작으로 읽히지 않게
      wantPlay = !!autoplay;
      const arg = { videoId: id, startSeconds };
      if (autoplay) {
        player.loadVideoById(arg);
        // loadVideoById 만으로는 시작하지 않는 환경이 있어(헤드리스 실측) 시작 못 했으면 재생을 다시 요청한다.
        // 사람이 멈췄으면(wantPlay=false) 하지 않는다.
        for (const ms of [900, 2500, 5000]) {
          setTimeout(() => { if (wantPlay && !playing && curId === id) player.playVideo(); }, ms);
        }
      } else player.cueVideoById(arg);
    },
    seek(sec) {
      const t = Math.max(0, Number(sec) || 0);
      base.tracker.cmd('seek', { pos: t });
      player.seekTo(t, true);
    },
    play() { base.tracker.cmd('play', { playing: true }); wantPlay = true; player.playVideo(); },
    pause() { base.tracker.cmd('pause', { playing: false }); wantPlay = false; player.pauseVideo(); },
    getTime: timeNow,
    getVideoId() {
      if (Date.now() - loadAt < 3000) return curId;  // 방금 우리가 바꿨다. 플레이어가 따라오기 전이다
      try { const d = player.getVideoData(); if (d && d.video_id) curId = d.video_id; } catch { /* 준비 전 */ }
      return curId;
    },
    getTitle() { try { return (player.getVideoData() || {}).title || ''; } catch { return ''; } },
    isPlaying() { return playing; },
    onChange: base.onChange,
    destroy() { try { player.destroy(); } catch { /* 이미 사라짐 */ } },
  };
}

export async function createPlayer({ container, fake, muted, placeholderId }) {
  return fake ? createFake(container) : createYouTube(container, muted, placeholderId);
}
