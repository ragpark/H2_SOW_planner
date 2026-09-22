#!/bin/sh
# A mounted volume arrives owned by root, but the app runs unprivileged. Start
# as root only long enough to hand the mount to the app user, then drop
# privileges for the process that actually serves traffic.
set -e

claim_mount() {
  dir="$1"
  [ -n "$dir" ] || return 0
  [ -d "$dir" ] || return 0
  owner=$(stat -c '%u' "$dir" 2>/dev/null || echo '')
  [ "$owner" = "$APP_UID" ] && return 0
  chown "$APP_UID:$APP_GID" "$dir" || echo "WARNING: could not take ownership of $dir" >&2
}

APP_UID=${APP_UID:-1000}
APP_GID=${APP_GID:-1000}

if [ "$(id -u)" = "0" ]; then
  claim_mount "$RAILWAY_VOLUME_MOUNT_PATH"
  # Any other explicitly configured data directory gets the same treatment.
  if [ -n "$DATABASE_FILE" ]; then
    claim_mount "$(dirname "$DATABASE_FILE")"
  fi
  # exec so the app is PID 1 and receives SIGTERM directly on redeploy.
  exec gosu "$APP_UID:$APP_GID" "$@"
fi

exec "$@"
