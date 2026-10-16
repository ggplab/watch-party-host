// cp public/config.example.js public/config.js 로 복사해 값을 채운다. config.js 는 .gitignore 대상이라 커밋되지 않는다.

window.CHAT_CONFIG = {
  // Supabase 대시보드 > Settings > API 의 anon(public) 키만 쓴다.
  // service_role 키(sb_secret_...)는 절대 넣지 않는다.
  SUPABASE_URL: 'https://여기에_프로젝트_ref.supabase.co',
  SUPABASE_ANON_KEY: '여기에_anon_public_key',

  // ?room= 이 없을 때 들어가는 방
  DEFAULT_ROOM: 'demo',

  // 배포 주소(링크 공유용 안내에만 쓴다). 안 쓰면 비워 둔다.
  PUBLIC_BASE_URL: 'https://watch-party-sync.pages.dev',

  // 방장 전용 회차 버튼. label 은 상태 줄에 그대로 보인다.
  EPISODES: [
    { label: '1화', videoId: 'mE8yrHFjatQ' },
    { label: '2화', videoId: '-pOWXSqTxF0' },
    { label: '3화', videoId: 'LxlTwNX0EV0' },
  ],

  // 새로 온 사람 알림(요약 카드)을 보내는 최소 간격(ms). 기본 5분
  RECAP_INTERVAL_MS: 300000,

  // 영상 위 오버레이에서 메시지가 머무는 시간(ms)과 동시에 보이는 최대 줄 수
  MESSAGE_TTL: 12000,
  MAX_MESSAGES: 8,

  // 처음 들어온 사람에게 붙는 닉네임 재료 (앞 단어 + 뒷 단어)
  NICKNAME_WORDS: {
    first: ['조용한', '궁금한', '느긋한', '재빠른', '졸린', '배고픈', '씩씩한', '다정한',
            '엉뚱한', '부지런한', '꼼꼼한', '용감한', '신중한', '명랑한', '나른한', '상냥한'],
    second: ['판다', '여우', '수달', '두더지', '고래', '참새', '너구리', '다람쥐',
             '펭귄', '올빼미', '알파카', '해달', '코알라', '오리', '사슴', '햄스터'],
  },

  // 이 단어가 들어간 메시지는 화면에 띄우지 않는다 (받는 쪽에서 거른다)
  BLOCK_WORDS: [],
};
