#!/usr/bin/env bash
# Oracle Cloud 무료 서버(Ubuntu)에 AI 투자 비서를 설치한다.
#   사용법: bash setup.sh https://github.com/<아이디>/<저장소>.git
# 두 번 실행해도 안전하다(업데이트할 때도 같은 명령을 다시 실행).
set -euo pipefail

REPO_URL="${1:?GitHub 저장소 주소를 넣어 주세요. 예: bash setup.sh https://github.com/me/invest-app.git}"
APP_DIR=/opt/invest/app
DATA_DIR=/var/lib/invest
ENV_FILE=/etc/invest.env

echo "▶ 1/6 기본 패키지"
sudo apt-get update -y
sudo apt-get install -y ca-certificates curl git

echo "▶ 2/6 메모리 보조(스왑 2GB) — 무료 서버는 메모리가 작아서 빌드할 때 필요"
if ! sudo swapon --show | grep -q /swapfile; then
  sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
  grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
fi

echo "▶ 3/6 Node.js 24"
if ! node -v 2>/dev/null | grep -q '^v24'; then
  curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi

echo "▶ 4/6 앱 코드 받기와 빌드"
sudo id invest >/dev/null 2>&1 || sudo useradd -r -m -d /opt/invest -s /usr/sbin/nologin invest
sudo mkdir -p "$DATA_DIR" && sudo chown invest:invest "$DATA_DIR"
if [ -d "$APP_DIR/.git" ]; then
  sudo -u invest git -C "$APP_DIR" pull --ff-only
else
  sudo -u invest git clone "$REPO_URL" "$APP_DIR"
fi
cd "$APP_DIR"
sudo -u invest npm ci --no-audit --no-fund
sudo -u invest npm run build

echo "▶ 5/6 설정 파일과 자동 실행"
if [ ! -f "$ENV_FILE" ]; then
  sudo install -m 600 -o invest -g invest /dev/null "$ENV_FILE"
  sudo tee "$ENV_FILE" >/dev/null <<'EOF'
NODE_ENV=production
PORT=8080
DATA_DIR=/var/lib/invest
APP_PASSWORD=
SESSION_SECRET=
ANTHROPIC_API_KEY=
KIS_APP_KEY=
KIS_APP_SECRET=
VAPID_PUBLIC_KEY=
VAPID_PRIVATE_KEY=
VAPID_SUBJECT=mailto:
EOF
  echo "   → $ENV_FILE 를 만들었어요. 'sudo nano $ENV_FILE' 로 값을 채운 뒤 이 스크립트를 한 번 더 실행하세요."
fi
sudo tee /etc/systemd/system/invest.service >/dev/null <<EOF
[Unit]
Description=AI 투자 비서
After=network-online.target
Wants=network-online.target

[Service]
User=invest
WorkingDirectory=$APP_DIR
EnvironmentFile=$ENV_FILE
ExecStart=/usr/bin/node server/dist/index.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
if sudo grep -qE '^APP_PASSWORD=.{12,}' "$ENV_FILE"; then
  sudo systemctl enable --now invest
  sudo systemctl restart invest
  sleep 3
  curl -fsS http://127.0.0.1:8080/api/health && echo "   → 서버 실행 중"
else
  echo "   → 아직 APP_PASSWORD가 비어 있어서 서버를 켜지 않았어요."
fi

echo "▶ 6/6 Tailscale(폰에서만 들어가는 HTTPS 주소)"
if ! command -v tailscale >/dev/null; then
  curl -fsSL https://tailscale.com/install.sh | sh
fi
if ! sudo tailscale status >/dev/null 2>&1; then
  echo "   → 아래에 나오는 주소를 브라우저로 열어 Tailscale에 로그인하세요."
  sudo tailscale up
fi
sudo tailscale serve --bg 8080 || true
echo
echo "완료. 폰 주소:"
sudo tailscale serve status | grep -o 'https://[^ ]*' | head -1 || true
