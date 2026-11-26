# AI 투자 비서

코인(OKX)·한국주식·미국주식(한국투자증권)을 한 화면에서 보고, Claude와 GPT에게 매매 타이밍 분석, 차트 지점 분석, 채팅 상담, 매일 아침 [속보]를 받는 **혼자 쓰는** 웹앱입니다. 폰 홈 화면에 추가하면 일반 앱처럼 쓸 수 있습니다.

- 주문 기능은 없습니다. 사고파는 건 거래소·증권사 앱에서 직접 하세요.
- 투자 판단과 책임은 본인에게 있습니다.
- 다른 사람과 같이 쓰면 안 됩니다(구독 약관상 본인만 사용 가능).

---

## 준비물

| 항목 | 용도 |
|---|---|
| GitHub 계정 | 코드 저장(공개 저장소) |
| 서버 | **Oracle Cloud 평생 무료 서버(추천, 0원)** 또는 Railway(월 5달러 정도) |
| Tailscale 계정(무료) | Oracle로 배포할 때, 폰에서만 들어가는 HTTPS 주소 |
| PC에 Node.js 24 | ChatGPT 로그인 도구 실행(한 번) |
| Claude Max 또는 Ultra 구독 | 매달 들어오는 API 크레딧으로 Claude 사용 |
| ChatGPT Plus 구독 | GPT 사용 |
| OKX 계정 | 코인 시세·보유 현황 |
| 한국투자증권 계좌 | 한국·미국 주식 시세·보유 현황 |

---

## 1. 키와 값 준비하기

### 1-1. Claude API 키 (구독 크레딧 사용)

1. **브라우저**로 claude.ai에 들어가 설정에서 "API 크레딧"을 받습니다. 요금제를 시작한 지 7일이 지나야 받을 수 있습니다.
2. 크레딧을 연결할 Console 조직을 고릅니다(platform.claude.com).
3. Console에서 API 키를 만듭니다.
4. **결제 수단은 등록하지 마세요.** 그러면 크레딧을 다 써도 추가 요금 없이 멈춥니다.

### 1-2. OKX 읽기 전용 키

1. OKX → 내 정보 → API → API 키 만들기.
2. 권한은 **읽기(Read)만** 체크합니다. 거래·출금은 체크하지 마세요.
3. 패스프레이즈를 정하고, API 키·시크릿·패스프레이즈를 적어 둡니다.

### 1-3. 한국투자증권 앱키

1. 한국투자증권 홈페이지나 앱에서 "KIS Developers(Open API)"를 신청합니다.
2. 연결할 계좌를 고르고 앱키·앱시크릿을 받습니다.
3. 계좌번호 앞 8자리와 상품코드 2자리(보통 `01`)를 적어 둡니다.

> **어느 계좌 키를 쓸지 고르세요.** 한국투자증권 키는 조회만 되도록 제한할 수 없습니다. 이 앱은 조회용 주소만 부르도록 막아 두었지만, 키 자체로는 주문도 가능합니다.
>
> | 방법 | 장점 | 위험 |
> |---|---|---|
> | 지금 쓰는 계좌의 키 | 보유 주식이 자동으로 보임 | 키가 새면 주문 가능 |
> | 돈을 넣지 않은 시세용 계좌의 키 | 키가 새도 잃을 돈이 없음 | 보유 주식은 앱에서 직접 입력 |

### 1-4. 웹 푸시 키(VAPID)

PC 터미널에서 이 저장소 폴더를 열고:

```
npx web-push generate-vapid-keys
```

나온 Public Key와 Private Key를 적어 둡니다.

### 1-5. 앱 비밀번호와 세션 비밀값

- `APP_PASSWORD`: 앱에 들어갈 때 쓸 비밀번호(12자 이상).
- `SESSION_SECRET`: 아래 명령으로 만든 임의 문자열.

```
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

---

## 2-A. 무료로 배포하기: Oracle Cloud + Tailscale (추천)

PC를 꺼도 24시간 돌아가고 비용이 들지 않습니다. 앱은 인터넷에 공개되지 않고, Tailscale에 로그인한 내 기기(폰, PC)에서만 들어갈 수 있습니다.

### ① Oracle Cloud 가입
1. oracle.com/cloud/free 에서 가입합니다. 본인 확인용으로 카드 등록이 필요하지만, 무료 범위(Always Free) 안에서는 청구되지 않습니다.
2. **홈 지역(Home Region)은 서울(South Korea Central) 또는 춘천**을 고릅니다. 나중에 못 바꿉니다.
3. (권장) 계정을 "종량제(Pay As You Go)"로 올립니다. 무료 범위 안에서는 여전히 0원이고, 오래 놀고 있는 무료 서버를 Oracle이 회수하는 정책의 대상에서 빠집니다. 정확한 조건은 Oracle 안내를 확인하세요.

### ② 서버 만들기
1. 콘솔 → Compute → Instances → **Create instance**.
2. Image: **Ubuntu 24.04**.
3. Shape: **Ampere(VM.Standard.A1.Flex) 1 OCPU / 6GB** 를 추천합니다(무료). "용량 부족(Out of capacity)"이 뜨면 **VM.Standard.E2.1.Micro**(무료)를 고르세요. 설치 스크립트가 메모리를 보충합니다.
4. SSH 키: "Generate a key pair for me" → **개인 키 저장(Save private key)**. 잃어버리면 접속할 수 없습니다.
5. Create → 상태가 RUNNING이 되면 **Public IP**를 적어 둡니다. 방화벽(포트) 설정은 건드리지 않아도 됩니다. Tailscale이 알아서 연결합니다.

### ③ 서버 접속 (PC의 PowerShell)
```
ssh -i <저장한 개인키 파일 경로> ubuntu@<Public IP>
```
처음 접속하면 "yes"를 입력합니다.

### ④ 설치 (서버에서)
```
curl -fsSL https://raw.githubusercontent.com/<아이디>/<저장소>/main/deploy/oracle/setup.sh -o setup.sh
bash setup.sh https://github.com/<아이디>/<저장소>.git
```
1. 처음 실행하면 설정 파일 `/etc/invest.env`를 만들고 멈춥니다. `sudo nano /etc/invest.env`로 1번에서 준비한 값을 채우고 저장합니다(Ctrl+O, Enter, Ctrl+X). 값은 아래 2-B의 환경변수 표와 같습니다.
2. `bash setup.sh <저장소 주소>`를 한 번 더 실행합니다. 서버가 켜지고, Tailscale 로그인 주소가 나오면 브라우저로 열어 로그인합니다.
3. 마지막에 `https://<서버이름>.<tailnet>.ts.net` 주소가 나옵니다. 이게 앱 주소입니다.

서버는 재부팅해도 자동으로 다시 켜집니다. 코드가 바뀌면 같은 `bash setup.sh <저장소 주소>`를 다시 실행하면 업데이트됩니다.

### ⑤ 폰과 PC 연결
1. 폰과 PC에 **Tailscale 앱**을 설치하고, 서버와 **같은 계정**으로 로그인합니다.
2. 폰의 Tailscale을 켜 둔 상태에서 ④-3의 주소를 엽니다.
3. ChatGPT Plus 연결은 아래 3번을 따르되, 주소에 Tailscale 주소를 넣습니다(PC의 Tailscale이 켜져 있어야 함).

---

## 2-B. Railway에 배포하기 (유료, 가장 쉬움)

1. 이 코드를 GitHub 저장소에 올립니다(공개 저장소). `.env` 파일이나 키는 절대 올리지 마세요. 커밋할 때 비밀값 검사가 자동으로 돌아갑니다.
2. Railway → New Project → Deploy from GitHub repo → 이 저장소를 고릅니다.
3. 서비스 → **Volumes** → Add Volume → 마운트 경로 `/data`. (DB와 로그인 토큰이 여기 저장됩니다. 없으면 재배포 때 지워집니다.)
4. 서비스 → **Variables**에 아래 값을 넣습니다.

| 이름 | 값 |
|---|---|
| `NODE_ENV` | `production` |
| `DATA_DIR` | `/data` |
| `APP_PASSWORD` | 1-5에서 정한 비밀번호 |
| `SESSION_SECRET` | 1-5에서 만든 값 |
| `ANTHROPIC_API_KEY` | 1-1의 Claude API 키 |
| `OKX_API_KEY` / `OKX_API_SECRET` / `OKX_API_PASSPHRASE` | 1-2의 값 |
| `KIS_APP_KEY` / `KIS_APP_SECRET` | 1-3의 값 |
| `KIS_ACCOUNT_NO` | 계좌번호 앞 8자리 |
| `KIS_ACCOUNT_PRODUCT` | 상품코드 2자리(보통 `01`) |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | 1-4의 값 |
| `VAPID_SUBJECT` | `mailto:` 뒤에 본인 이메일 |
| `OPENAI_API_KEY` | (선택) GPT 비상용 종량제 키 |

5. 서비스 → Settings → Networking → **Generate Domain**으로 주소를 만듭니다.
6. 배포가 끝나면 `https://<주소>/api/health`가 `{"ok":true}`를 보여주는지 확인합니다.

서버는 복제본 1개로만 돌려야 합니다(`railway.json`에 설정돼 있음).

---

## 3. ChatGPT Plus 연결하기 (PC에서 한 번)

ChatGPT 로그인은 PC 브라우저에서만 할 수 있어서, PC에서 로그인한 뒤 결과를 서버로 보냅니다. 로그인 정보는 PC에 남지 않습니다.

1. PC에 Node.js 24를 설치하고, 이 저장소 폴더에서 `npm install`을 한 번 실행합니다.
2. 아래 명령을 실행합니다(주소는 2-5에서 만든 주소).

```
npm run siwc:login -w server -- --server https://<앱 주소>
```

3. 앱 비밀번호를 입력하면 브라우저에 ChatGPT 로그인 창이 열립니다. 로그인하고 "플랜 사용"을 허용합니다.
4. 터미널에 "ChatGPT Plus 연결 완료"가 나오면 끝입니다.

서버가 30일 넘게 GPT를 쓰지 않거나 연결이 끊기면, 앱 설정 화면에 "연결 안 됨"이 뜹니다. 그때 이 과정을 다시 하면 됩니다.

---

## 4. 폰에 설치하기

- **아이폰**: Safari로 앱 주소 열기 → 공유 버튼 → "홈 화면에 추가". 알림은 홈 화면에 추가한 앱에서만 받을 수 있습니다.
- **안드로이드**: Chrome으로 앱 주소 열기 → 메뉴 → "앱 설치" 또는 "홈 화면에 추가".

홈 화면 앱을 열고 로그인 → 설정 → **알림 켜기**를 누르세요.

---

## 5. 처음 확인하기

1. 코인 · 한국주식 · 미국주식 탭에 보유 종목이 보이는지 확인합니다.
2. 종목을 눌러 차트가 뜨는지, 캔들을 누르면 "왜 움직였는지" 설명이 오는지 확인합니다.
3. 설정 → **지금 브리핑 만들기**를 누르고 1분 정도 뒤에 맨 위 소식이 생기는지 확인합니다.

> 한국투자증권 응답의 일부 필드 이름은 공개 예제로 확인하지 못했습니다. 주식 탭이 비어 보이거나 가격이 0으로 나오면 그 화면을 캡처해 두세요. 필드 이름만 고치면 됩니다.

---

## 비용과 한도

- Claude는 구독 크레딧에서 나갑니다. 설정 화면에서 하루·한 달 한도를 정할 수 있고(기본: 하루 직접 사용 3달러, 하루 예약 작업 1.5달러, 한 달 80달러), 넘으면 AI 호출을 멈춥니다.
- GPT는 ChatGPT Plus 사용량에서 나갑니다(추가 비용 없음). Plus 한도에 닿으면 앱에 안내가 뜹니다. ChatGPT 연결이 막히면 설정에서 "OpenAI 종량제(비상용)"로 바꿀 수 있습니다(`OPENAI_API_KEY` 필요, 한 달 5달러 한도).
- 매일 아침 8시 브리핑, 매시 5분 급변(±5%)·청산 근접(5% 이내) 확인이 자동으로 돌아갑니다.

## 문제 해결

| 증상 | 할 일 |
|---|---|
| "ChatGPT 다시 로그인이 필요합니다" | 3번 과정을 다시 실행 |
| "Claude API 키를 확인하세요" | Railway의 `ANTHROPIC_API_KEY` 확인 |
| "이번 달 AI 사용 한도에 도달했습니다" | 설정에서 한도 조정, 또는 다음 달까지 대기 |
| 한국투자증권 데이터를 못 가져옴 | 앱키·계좌번호 확인. 하루에 토큰을 너무 자주 받으면 잠시 막힐 수 있음 |
| 알림이 안 옴(아이폰) | 홈 화면에 추가한 앱에서 알림 켜기를 다시 누르기 |

## 개발

```
npm install
npm test
npm run build
```

로컬 실행: 저장소 폴더에 `.env.local`(커밋 금지)을 만들고 `node --env-file=.env.local server/dist/index.js`.
