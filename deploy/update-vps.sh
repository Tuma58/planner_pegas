#!/usr/bin/env bash
set -Eeuo pipefail
umask 027

[[ "${EUID}" -eq 0 ]] || { echo "Обновление необходимо запускать через sudo" >&2; exit 1; }
source /etc/pegas-planner/deploy.env
REPO_ACCESS="${REPO_ACCESS:-private}"
[[ "$REPO_ACCESS" == "public" || "$REPO_ACCESS" == "private" ]] || {
  echo "Некорректный REPO_ACCESS в deploy.env" >&2
  exit 2
}

DEPLOY_KEY="/etc/pegas-planner/deploy_key"
GIT_KNOWN_HOSTS="/etc/pegas-planner/known_hosts"
git_ssh="ssh -i $DEPLOY_KEY -o IdentitiesOnly=yes -o UserKnownHostsFile=$GIT_KNOWN_HOSTS -o StrictHostKeyChecking=yes"
lock_file="/run/lock/pegas-planner-update.lock"
deployment_changed=0
current_commit=""

rollback_on_error() {
  update_exit=$?
  trap - ERR
  set +e
  if [[ "$deployment_changed" -eq 1 && -n "$current_commit" ]]; then
    echo "Ошибка update-deploy, выполняется откат к $current_commit" >&2
    git checkout --detach "$current_commit"
    docker compose build
    docker compose up -d --remove-orphans
    docker compose logs --tail=150
  fi
  exit "$update_exit"
}
trap rollback_on_error ERR

exec 9>"$lock_file"
flock -n 9 || { echo "Другое обновление уже выполняется" >&2; exit 1; }

cd "$APP_DIR"
[[ -z "$(git status --porcelain --untracked-files=no)" ]] || {
  echo "В каталоге приложения есть локальные изменения; обновление остановлено" >&2
  exit 1
}

current_commit="$(git rev-parse HEAD)"
if [[ "$REPO_ACCESS" == "private" ]]; then
  [[ -s "$DEPLOY_KEY" && -s "$GIT_KNOWN_HOSTS" ]] || {
    echo "Не найдены deploy key или known_hosts для приватного репозитория" >&2
    exit 2
  }
  GIT_SSH_COMMAND="$git_ssh" git fetch --prune origin "$REPO_BRANCH"
else
  git fetch --prune origin "$REPO_BRANCH"
fi
target_commit="$(git rev-parse "origin/$REPO_BRANCH")"

if [[ "$current_commit" == "$target_commit" ]]; then
  echo "Уже установлена актуальная версия $current_commit"
  exit 0
fi
git merge-base --is-ancestor "$current_commit" "$target_commit" || {
  echo "Удаленная ветка не является fast-forward продолжением текущей версии" >&2
  exit 1
}

/usr/local/sbin/pegas-planner-backup
git merge --ff-only "$target_commit"
deployment_changed=1
docker compose config --quiet
docker compose build --pull
docker compose up -d --remove-orphans

healthy=0
planner_container="$(docker compose ps -q planner)"
[[ -n "$planner_container" ]] || { docker compose logs --tail=150; false; }
for _ in $(seq 1 60); do
  health_status="$(docker inspect --format '{{.State.Health.Status}}' "$planner_container" 2>/dev/null || true)"
  if [[ "$health_status" == "healthy" ]]; then
    healthy=1
    break
  fi
  if [[ "$health_status" == "unhealthy" ]]; then
    break
  fi
  sleep 2
done

if [[ "$healthy" -ne 1 ]]; then
  echo "Новая версия не прошла health-check" >&2
  false
fi

deployment_changed=0
trap - ERR
install -m 0750 "$APP_DIR/deploy/update-vps.sh" /usr/local/sbin/pegas-planner-update
install -m 0750 "$APP_DIR/deploy/backup-vps.sh" /usr/local/sbin/pegas-planner-backup
install -m 0644 "$APP_DIR/deploy/pegas-planner-backup.service" /etc/systemd/system/
install -m 0644 "$APP_DIR/deploy/pegas-planner-backup.timer" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now pegas-planner-backup.timer
echo "Обновление завершено: $current_commit → $target_commit"
