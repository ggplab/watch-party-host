// 오버레이와 학생 페이지가 함께 쓰는 규칙.
//
// 보내는 쪽 쿨다운은 학생 브라우저 안에 있어서 개발자도구를 열 줄 알면 우회된다.
// 그래서 도배·중복·금칙어는 "받아서 그리는 쪽" 에서 막는다. 화면이 둘(프로젝터,
// 학생 폰)이므로 규칙이 두 벌이 되지 않도록 여기 한 곳에 모아 둔다.

window.chatCore = (function () {
  /** 닉네임 → 고정 색상 (같은 사람은 늘 같은 색) */
  const COLORS = ['#ff7b72', '#ffa657', '#ffd866', '#7ee787', '#79c0ff',
                  '#a5a2ff', '#e6a3ff', '#5ee6c4', '#ff9ecd', '#b6e35a'];

  function colorFor(name) {
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
    return COLORS[h % COLORS.length];
  }

  // 이모지 칸은 가장 크게 뜬다. 여기에 임의 문자열이 들어오면 어떤 메시지보다
  // 크게 박히므로 진짜 그림문자만 통과시킨다.
  const EMOJI_ONLY = /^\p{Extended_Pictographic}(‍\p{Extended_Pictographic})*️?$/u;
  const isEmoji = (s) => EMOJI_ONLY.test(String(s || '').trim());

  /**
   * 화면 하나당 하나씩 만들어 쓰는 검사기.
   * 상태(누가 언제 몇 개 보냈는지)를 안에 가지고 있으므로 공유하지 않는다.
   */
  function makeGate(cfg) {
    const RATE_WINDOW = 10000;   // 10초 안에
    const RATE_MAX = 3;          // 같은 닉네임으로 3개까지
    const recent = new Map();    // 닉네임 → 최근 도착 시각들
    const lastText = new Map();  // 닉네임 → 마지막 문장 (연속 중복 차단)
    const words = (cfg && cfg.BLOCK_WORDS) || [];

    function blocked(text) {
      const lower = text.toLowerCase();
      return words.some((w) => w && lower.includes(String(w).toLowerCase()));
    }

    /** 그려도 되는 메시지면 {name, text} 를, 아니면 null 을 준다 */
    return function accept(payload) {
      if (!payload) return null;
      const name = String(payload.name || '익명').slice(0, 12);
      const text = String(payload.text || '').slice(0, 120);
      if (!text || blocked(text)) return null;

      const now = Date.now();
      const hits = (recent.get(name) || []).filter((t) => now - t < RATE_WINDOW);
      if (hits.length >= RATE_MAX) return null;
      if (lastText.get(name) === text) return null;

      hits.push(now);
      recent.set(name, hits);
      lastText.set(name, text);
      return { name, text };
    };
  }

  return { colorFor, isEmoji, makeGate };
})();
