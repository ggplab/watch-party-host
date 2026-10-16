# 룸 화면 영상 오른쪽 스크롤바 깜빡임: 윈도우 PC 인계

> 2026-10-16 맥북 세션에서 남김. 윈도우 PC의 Claude Code에 아래 「프롬프트」 절을 그대로 붙여 넣는다.

## 증상

룸 화면(`/room`, PC 나란히 모드)에서 영상 오른쪽에 세로 스크롤바가 이따금 생겼다 사라진다.
윈도우에서 눈에 띈다. 맥은 스크롤바가 화면 위에 겹쳐 떠서 레이아웃을 밀지 않기 때문이다.

## 맥에서 확인한 것

- 가장 의심되는 곳은 `static/room/index.html` 181행의 `body[data-mode="side"] #main { overflow-y: auto; }`다.
  `#main`은 flex 세로 배치이고, 그 안에서 `#stage`가 `flex: 1 1 auto; min-height: 240px`로 남는 높이를 채운다.
- 배포본을 데모 모드(`?demo=1`), 1400x850 크기로 열어 확인했다. 상태 줄 버튼 조합을 바꾸고, 배너를 띄우고,
  `#app` 높이를 380~1100px 사이에서 0.25px씩 바꿔 봐도 `#main`은 넘치지 않았다.
  넘친 것은 높이가 약 380px 아래로 줄어 `#stage`가 최소 높이 240px에 닿았을 때뿐이다.
- 방장 화면에서만 보이는 `#hostTools`(방장 전용 줄)는 확인하지 못했다. 이 줄도 `#main` 안에 있고
  `flex-wrap: wrap`이라 줄바꿈되면 높이가 바뀐다.
- 코드는 아직 고치지 않았다.

## 프롬프트

```text
watch-party-host 레포(github.com/ggplab/watch-party-host)를 pull 받은 상태야.
docs/handoff/2026-10-16-room-scrollbar-flicker.md 를 먼저 읽어 줘.

룸 화면(/room, PC 나란히 모드)에서 영상 오른쪽에 세로 스크롤바가 이따금 생겼다 사라지는 버그를 잡아 줘.

1. 배포본 https://watch-party-host-1011836345966.asia-northeast3.run.app/room 을 윈도우 크롬에서
   데모 모드(?demo=1)와 방장 화면 두 가지로 열어서, 스크롤바가 생기는 순간을 재현해 줘.
2. 스크롤바가 뜰 때 콘솔에서 아래 코드로 어느 칸이 넘치는지 확인해 줘.
   [...document.querySelectorAll('*')].filter(e=>/auto|scroll/.test(getComputedStyle(e).overflowY)&&e.scrollHeight>e.clientHeight).map(e=>[e.id||e.className,e.scrollHeight,e.clientHeight])
   그 순간 높이가 바뀐 칸(#syncbar, #hostTools, #banner 등)도 ResizeObserver로 기록해 줘.
3. 원인이 확인되면 고칠 방법을 제안하고, 내 승인을 받은 뒤 수정해 줘.
   방향은 영상 칸이 스크롤하는 대신 영상(#stage)이 줄어서 공간을 맞추는 쪽이야.
   스크롤바 자리를 늘 비워 두는 scrollbar-gutter는 영상 옆에 빈 띠가 생기니까 피해 줘.
4. 고친 뒤 같은 조건에서 스크롤바가 다시 안 생기는지 확인하고 커밋해 줘. 배포는 내가 하라고 할 때만.
```
