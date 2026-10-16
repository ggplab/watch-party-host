(function () {
  var VIDEO_ID = 'mE8yrHFjatQ';
  var t = 1200;
  var player = null, ready = false;
  var chatLog = [], shield = null, shieldPending = true;
  var COLORS = ['#3b6fd8', '#d8693b', '#3ba86b', '#a03bd8', '#d8b83b', '#3bb8d8'];

  function mmss(s) {
    s = Math.max(0, Math.floor(s));
    var m = Math.floor(s / 60), r = s % 60;
    return (m < 10 ? '0' : '') + m + ':' + (r < 10 ? '0' : '') + r;
  }
  function sec(x) {
    var p = String(x).split(':').map(Number), n = 0;
    for (var i = 0; i < p.length; i++) n = n * 60 + (p[i] || 0);
    return n;
  }
  function $(id) { return document.getElementById(id); }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function setT(v, seek) {
    t = Math.max(0, Math.min(1800, Math.floor(v)));
    $('slider').value = t;
    $('tlabel').textContent = mmss(t);
    $('badge').textContent = 'You are at ' + mmss(t);
    if (seek && ready && player && player.seekTo) {
      try { player.seekTo(t, true); } catch (e) {}
    }
    renderChat();
  }

  window.onYouTubeIframeAPIReady = function () {
    try {
      player = new YT.Player('player', {
        videoId: VIDEO_ID,
        playerVars: { start: 1200, rel: 0 },
        events: {
          onReady: function () { ready = true; try { player.seekTo(t, true); player.pauseVideo(); } catch (e) {} },
        }
      });
    } catch (e) { ready = false; }
  };
  setInterval(function () {
    if (!ready || !player || !player.getPlayerState) return;
    try {
      if (player.getPlayerState() === 1) {
        var c = Math.floor(player.getCurrentTime());
        if (c !== t) setT(c, false);
      }
    } catch (e) {}
  }, 1000);

  $('slider').addEventListener('input', function (e) { setT(Number(e.target.value), true); });

  fetch('/static/demo/friends.json').then(function (r) { return r.json(); }).then(function (list) {
    var box = $('friends');
    list.forEach(function (f) {
      var b = el('button', 'chip', f.name + ' ▶ ' + f.t);
      b.addEventListener('click', function () { setT(sec(f.t), true); });
      box.appendChild(b);
    });
  }).catch(function () {});

  // AI panel
  function showAnswer(node) { var a = $('answer'); a.textContent = ''; a.appendChild(node); }
  function ask(question) {
    var ask_t = t;
    showAnswer(el('div', 'answer muted', 'Thinking…'));
    $('catchup').disabled = true; $('askbtn').disabled = true;
    fetch('/ask', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ video_id: VIDEO_ID, t_sec: ask_t, question: question })
    }).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (d) {
        if (!d.answerable) {
          showAnswer(el('div', 'answer muted', 'Not shown yet at ' + mmss(ask_t) + '. Ask again later.'));
          return;
        }
        var card = el('div', 'answer');
        card.appendChild(el('p', 'ko', d.answer_ko || ''));
        if (d.answer_en) card.appendChild(el('p', 'en', d.answer_en));
        var chips = el('div', 'chips');
        (d.cites || []).forEach(function (c) {
          var b = el('button', 'chip', c);
          b.addEventListener('click', function () { setT(sec(c), true); });
          chips.appendChild(b);
        });
        card.appendChild(chips);
        var secs = d.latency_ms != null ? (d.latency_ms / 1000).toFixed(1) + ' s' : '';
        card.appendChild(el('div', 'foot', d.cached ? 'answered from Argon scene log, cached (demo replay)' : 'answered from Argon scene log, ' + secs));
        showAnswer(card);
      })
      .catch(function (e) { showAnswer(el('div', 'answer muted', 'Something went wrong. Try again.')); })
      .then(function () { $('catchup').disabled = false; $('askbtn').disabled = false; });
  }
  $('catchup').addEventListener('click', function () { ask('지금까지 무슨 일이 있었는지 요약해 줘'); });
  function submitAsk() { var v = $('q').value.trim(); if (v) ask(v); }
  $('askbtn').addEventListener('click', submitAsk);
  $('q').addEventListener('keydown', function (e) { if (e.key === 'Enter') submitAsk(); });

  // Chat
  var nickColor = {};
  function colorFor(n) {
    if (!(n in nickColor)) nickColor[n] = COLORS[Object.keys(nickColor).length % COLORS.length];
    return nickColor[n];
  }
  function renderChat() {
    var box = $('chat');
    box.textContent = '';
    chatLog.forEach(function (m) {
      var row = el('div', 'msg');
      var info = shield && shield[m.id];
      if (shieldPending || !info) {
        row.className = 'msg locked';
        row.appendChild(el('span', null, '🔒 checking…'));
      } else {
        var hidden = !info.social && (info.refers_to == null || sec(info.refers_to) > t);
        if (hidden) {
          row.className = 'msg locked';
          row.appendChild(el('span', null, info.refers_to != null
            ? '🔒 A message about a later scene, opens at ' + info.refers_to
            : '🔒 Locked: scene not identified'));
        } else {
          var dot = el('span', 'dot'); dot.style.background = colorFor(m.nick);
          row.appendChild(dot);
          row.appendChild(el('span', 'nick', m.nick));
          row.appendChild(el('span', null, m.text));
          row.appendChild(el('span', 'tag', m.posted_at));
        }
      }
      box.appendChild(row);
    });
  }

  fetch('/static/demo/chat_log.json').then(function (r) { return r.json(); }).then(function (log) {
    chatLog = log;
    renderChat();
    return fetch('/shield', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ video_id: VIDEO_ID, t_sec: t, messages: log.map(function (m) { return { id: m.id, text: m.text }; }) })
    }).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (d) {
        shield = {};
        (d.results || []).forEach(function (x) { shield[x.id] = x; });
        // fail closed for anything missing
        log.forEach(function (m) { if (!shield[m.id]) shield[m.id] = { refers_to: null, social: false }; });
      });
  }).catch(function () {
    shield = {};
    chatLog.forEach(function (m) { shield[m.id] = { refers_to: null, social: false }; });
  }).then(function () { shieldPending = false; renderChat(); });

  setT(1200, false);
})();
