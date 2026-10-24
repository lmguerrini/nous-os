#!/bin/zsh
emulate -L zsh
set -eu -o pipefail
umask 077

# Resolve the real account before constructing any user-specific path or reading Keychain.
seal_environment() {
  local home_record name
  USER="$(/usr/bin/id -un)" || {
    print -u2 -- "Cannot resolve the current account."
    return 78
  }
  home_record="$(/usr/bin/dscl . -read "/$(/usr/bin/printf Users)/$USER" NFSHomeDirectory 2>/dev/null)" || {
    print -u2 -- "Cannot resolve the account home with dscl."
    return 78
  }
  case "$home_record" in
    "NFSHomeDirectory: "*) HOME="${home_record#NFSHomeDirectory: }" ;;
    *) print -u2 -- "Invalid account home record."; return 78 ;;
  esac
  [[ "$HOME" == /* && -n "$HOME" ]] || {
    print -u2 -- "Invalid account home path."
    return 78
  }
  LOGNAME=$USER
  PATH=/usr/bin:/bin:/usr/sbin:/sbin
  export HOME USER LOGNAME PATH

  for name in ${(f)"$(typeset +x)"}; do
    case "$name" in
      HOME|USER|LOGNAME|SHELL|PATH|TMPDIR|LANG|LC_ALL|LC_CTYPE|__CF_USER_TEXT_ENCODING|NOUSOS_TUNNEL_CLIENT|NOUSOS_TUNNEL_CLIENT_HOME|NOUSOS_GATE_CHILD|NOUSOS_PROPOSALS|NOUSOS_PYTHON) ;;
      *) unset "$name" 2>/dev/null || true ;;
    esac
  done
  XDG_CONFIG_HOME=$HOME/.config
  export XDG_CONFIG_HOME
}

seal_environment || exit $?

CONNECTOR=${0:A:h}
SCRIPT=$CONNECTOR/nousos-tunnel.sh
TEMPLATE=$CONNECTOR/com.nousos.tunnel.plist.template
GATE=$CONNECTOR/nousos_tunnel_gate.py
WATCHDOG=$CONNECTOR/nousos_tunnel_watchdog.py
STATE_HELPER=$CONNECTOR/nousos_tunnel_state.py
LOCK_HELPER=$CONNECTOR/nousos_tunnel_lock.py
PYTHON=${NOUSOS_PYTHON:-$(command -v python3 || true)}
[[ -n "$PYTHON" && -x "$PYTHON" ]] || { print -u2 -- "Set NOUSOS_PYTHON to an executable Python 3 interpreter."; exit 78; }
CLIENT=${NOUSOS_TUNNEL_CLIENT:-$(command -v tunnel-client || true)}
[[ -n "$CLIENT" ]] || { print -u2 -- "Set NOUSOS_TUNNEL_CLIENT to the tunnel-client executable, or add it to PATH."; exit 78; }
RUNTIME_PATH="/usr/bin:/bin:/usr/sbin:/sbin:${CLIENT:A:h}:${PYTHON:A:h}"
PATH=$RUNTIME_PATH
export PATH
GATE_CHILD=${NOUSOS_GATE_CHILD:-}
PROPOSALS=${NOUSOS_PROPOSALS:-}
export NOUSOS_TUNNEL_CLIENT="$CLIENT" NOUSOS_PYTHON="$PYTHON"
[[ -z "$GATE_CHILD" ]] || export NOUSOS_GATE_CHILD="$GATE_CHILD"
[[ -z "$PROPOSALS" ]] || export NOUSOS_PROPOSALS="$PROPOSALS"
PROFILE_DIR=$HOME/.config/tunnel-client
PROFILE=$PROFILE_DIR/nousos-read.yaml
LOGDIR=$HOME/Library/Logs/nousos-tunnel
STATEDIR=$HOME/Library/Application\ Support/nousos-tunnel
SESSION_PLIST=$STATEDIR/com.nousos.tunnel.plist
SESSION_ID_FILE=$STATEDIR/session.id
WATCHDOG_STATE=$STATEDIR/watchdog.state
START_LOCK=$STATEDIR/start.lock
MANUAL_STOP=$STATEDIR/manual-stop
AUTOSTART_PLIST=$HOME/Library/LaunchAgents/com.nousos.tunnel.plist
PRESENCE_PLIST=$HOME/Library/LaunchAgents/com.nousos.tunnel.presence.plist
JOB=gui/$UID/com.nousos.tunnel
WATCHDOG_LABEL=com.nousos.tunnel.watchdog
WATCHDOG_JOB=gui/$UID/$WATCHDOG_LABEL
PRESENCE_LABEL=com.nousos.tunnel.presence
PRESENCE_JOB=gui/$UID/$PRESENCE_LABEL
WATCHDOG_PLIST=$STATEDIR/$WATCHDOG_LABEL.plist
SERVICE=nousos-tunnel-runtime-key
PRESENCE_HELPER=$CONNECTOR/nousos_tunnel_presence.py
HEALTH=http://127.0.0.1:47931

usage() {
  print -u2 -- "Usage: $SCRIPT {install-profile <tunnel_id>|key-instructions|key-store|key-status|verify-key-scope|doctor|run|launchd-run|start [--idle <minutes>] [--max <minutes>]|start --for <minutes>|start --presence [--away <minutes>] [--max-hours <hours>]|stop|status|presence-enable|presence-disable|presence-tick|presence-resume|disable-autostart|logs [n]|rollback [--delete-key] [--remove-client]}"
  exit 2
}

key_present() {
  security find-generic-password -a "$USER" -s "$SERVICE" >/dev/null 2>&1
}

load_key() {
  if ! key_present; then
    print -u2 -- "Keychain item absent: run key-instructions."
    return 78
  fi
  local k
  k="$(security find-generic-password -a "$USER" -s "$SERVICE" -w)" || {
    print -u2 -- "Cannot read the Keychain item."
    return 78
  }
  [[ -n "$k" ]] || {
    unset k
    print -u2 -- "The Keychain item is empty."
    return 78
  }
  CONTROL_PLANE_API_KEY="$k"
  export CONTROL_PLANE_API_KEY
  unset k
}

loaded() {
  launchctl print "$JOB" >/dev/null 2>&1
}

loaded_from() {
  local description
  description="$(launchctl print "$JOB" 2>/dev/null)" || return 1
  [[ "$description" == *"$1"* ]]
}

# Match complete commands before reporting or signaling a process.
matching_pids() {
  ps -axww -o pid=,command= | "$PYTHON" -c '
import re
import sys

mode = sys.argv[1]
client = re.compile(
    re.escape(sys.argv[3]) + r" run --profile nousos-read"
)
# The framework python3 re-executes itself as Python.app, so match any Python
# executable whose arguments name this gate script exactly.
gate = re.compile(
    r"\S*[Pp]ython[^ ]*(?: \S+)*? "
    + re.escape(sys.argv[2])
    + r"(?: .*)?"
)
for line in sys.stdin:
    fields = line.strip().split(None, 1)
    if len(fields) != 2:
        continue
    pid, command = fields
    if not pid.isdecimal():
        continue
    if client.fullmatch(command) or (mode == "all" and gate.fullmatch(command)):
        print(pid)
' "$1" "$GATE" "$CLIENT"
}

has_client() {
  [[ -n "$(matching_pids client)" ]]
}

require_no_client() {
  # The process check gives an operator message; the inherited flock excludes races.
  if has_client; then
    print -u2 -- "A tunnel-client for nousos-read is already running."
    return 1
  fi
}

ready_code() {
  local code
  code="$(curl --noproxy '*' -s -m 2 -o /dev/null -w '%{http_code}' "$HEALTH/readyz" 2>/dev/null)" || true
  print -n -- "${code:-000}"
}

render_plist() {
  local dest=$1 mode=$2 tmp
  [[ -f "$TEMPLATE" ]] || {
    print -u2 -- "Missing plist template: $TEMPLATE"
    return 1
  }
  tmp="$(mktemp "$dest.XXXXXXXX")"
  chmod "$mode" "$tmp"
  if ! sed \
    -e "s|@SCRIPT@|$SCRIPT|g" \
    -e "s|@LOGDIR@|$LOGDIR|g" \
    -e "s|@HOME@|$HOME|g" \
    -e "s|@CLIENT@|$CLIENT|g" \
    -e "s|@GATE_CHILD@|$GATE_CHILD|g" \
    -e "s|@PROPOSALS@|$PROPOSALS|g" \
    -e "s|@PYTHON@|$PYTHON|g" \
    -e "s|@RUNTIME_PATH@|$RUNTIME_PATH|g" \
    "$TEMPLATE" > "$tmp"; then
    rm -f "$tmp"
    return 1
  fi
  if ! plutil -lint "$tmp" >/dev/null; then
    rm -f "$tmp"
    print -u2 -- "Rendered plist failed plutil -lint."
    return 1
  fi
  mv -f "$tmp" "$dest"
}

prepare_runtime_dirs() {
  mkdir -p "$LOGDIR" "$STATEDIR"
  chmod 700 "$LOGDIR" "$STATEDIR"
}

require_setup() {
  [[ -f "$PROFILE" && -x "$CLIENT" && -f "$GATE" && -n "$GATE_CHILD" ]] || {
    print -u2 -- "Missing profile, tunnel-client, or gate. Check the installation."
    return 1
  }
  key_present || {
    print -u2 -- "Keychain item absent: run key-instructions."
    return 78
  }
}

# The lock descriptor survives exec and closes when tunnel-client exits.
exec_locked_client() {
  prepare_runtime_dirs
  exec "$PYTHON" -c '
import fcntl
import os
import sys

fd = os.open(sys.argv[1], os.O_CREAT | os.O_RDWR, 0o600)
os.fchmod(fd, 0o600)
try:
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError:
    print("another NousOS tunnel-client holds the lock", file=sys.stderr)
    sys.exit(75)
os.set_inheritable(fd, True)
os.execv(sys.argv[2], sys.argv[2:])
' "$STATEDIR/tunnel.lock" "$CLIENT" run --profile nousos-read
}

do_stop() {
  local pid remaining
  if loaded; then
    launchctl bootout "$JOB" || return 1
  fi
  integer i=0
  while [[ -n "$(matching_pids all)" && $i -lt 10 ]]; do
    sleep 1
    (( i += 1 ))
  done
  while IFS= read -r pid; do
    [[ -n "$pid" ]] || continue
    kill -TERM "$pid" 2>/dev/null || true
  done < <(matching_pids all)

  i=0
  while [[ -n "$(matching_pids all)" && $i -lt 5 ]]; do
    sleep 1
    (( i += 1 ))
  done
  remaining="$(matching_pids all)"
  if [[ -n "$remaining" ]]; then
    print -u2 -- "Still running after SIGTERM (PIDs): $remaining"
    return 1
  fi
  print -- "Stopped launchd job and verified matching processes have exited."
}

cleanup_failed_start() {
  launchctl bootout "$WATCHDOG_JOB" >/dev/null 2>&1 || true
  rm -f "$SESSION_ID_FILE" "$WATCHDOG_STATE"
}

notify_state() {
  local state=$1 reason=$2 restart=${3:-start}
  /usr/bin/osascript -e "display notification \"$state — $reason. Restart: nousos-tunnel.sh $restart\" with title \"NousOS tunnel\"" >/dev/null 2>&1 || true
}

hid_idle_seconds() {
  "$PYTHON" -c '
import re, subprocess, sys
try:
    result = subprocess.run(["/usr/sbin/ioreg", "-c", "IOHIDSystem", "-d", "4"], capture_output=True, text=True, timeout=5, check=False)
    match = re.search(r"\"HIDIdleTime\"\s*=\s*(\d+)", result.stdout) if result.returncode == 0 else None
    if match is None: raise ValueError()
    print(int(match.group(1)) / 1_000_000_000)
except Exception:
    sys.exit(1)
' 2>/dev/null
}

if [[ "${1:-}" == start && "${2:-}" != --_lock-held ]]; then
  exec "$PYTHON" "$LOCK_HELPER" acquire "$START_LOCK" /bin/zsh "$SCRIPT" start --_lock-held "${@:2}"
fi

case "${1:-}" in
  install-profile)
    [[ $# -eq 2 && "$2" =~ '^tunnel_[0-9a-f]{32}$' ]] || usage
    mkdir -p "$PROFILE_DIR" "$LOGDIR"
    chmod 700 "$PROFILE_DIR" "$LOGDIR"
    if [[ -e "$PROFILE" ]]; then
      backup="$PROFILE.bak-$(date -u +%Y%m%dT%H%M%SZ)-$$"
      cp -p "$PROFILE" "$backup"
      chmod 600 "$backup"
    fi
    tmp="$(mktemp "$PROFILE_DIR/.nousos-read.yaml.XXXXXXXX")"
    chmod 600 "$tmp"
    API_KEY_REFERENCE='env:CONTROL_PLANE_API_KEY'
    cat > "$tmp" <<EOF
config_version: 1
control_plane:
  base_url: "https://api.openai.com"
  tunnel_id: "$2"
EOF
    printf '  api_key: "%s"\n' "$API_KEY_REFERENCE" >> "$tmp"
    cat >> "$tmp" <<EOF
health:
  listen_addr: "127.0.0.1:47931"
admin_ui:
  open_browser: false
log:
  level: info
  format: json
  file: "$LOGDIR/tunnel-client.ndjson"
mcp:
  commands:
    - channel: main
      command: "/usr/bin/env -u CONTROL_PLANE_API_KEY -u OPENAI_API_KEY -u OPENAI_ADMIN_KEY -u CLOUDFLARED_TOKEN -u CLOUDFLARED_TUNNEL_TOKEN $PYTHON $GATE"
  max_concurrent_requests: 4
EOF
    mv -f "$tmp" "$PROFILE"
    cat "$PROFILE"
    ;;
  key-instructions)
    [[ $# -eq 1 ]] || usage
    print -- 'Crea su Platform una chiave API Restricted con soltanto Tunnels Read + Use e premi Copy.'
    print -- "Poi, nel Terminale, esegui: $SCRIPT key-store"
    print -- 'Legge la chiave dagli appunti, la salva nel Portachiavi senza troncarla e svuota gli appunti.'
    print -- 'Non usare il prompt nascosto di "security ... -w": tronca a 128 caratteri.'
    ;;
  key-store)
    # The interactive "security add-generic-password -w" prompt truncates at 128
    # characters (observed 2026-09-25), shorter than a project key. Read the key
    # from the clipboard and hand it to "security -i" on stdin: never argv, no limit.
    [[ $# -eq 1 ]] || usage
    k="$(pbpaste)"
    k="${k//[[:space:]]/}"
    if [[ ! "$k" =~ '^sk-[A-Za-z0-9_-]{100,}$' ]]; then
      unset k
      print -u2 -- "The clipboard does not hold an OpenAI key (sk-..., 100+ characters). Copy the key on Platform, then retry."
      exit 65
    fi
    n=${#k}
    printf 'add-generic-password -U -a %s -s %s -w %s\n' "$USER" "$SERVICE" "$k" | security -i
    unset k
    pbcopy </dev/null
    k2="$(security find-generic-password -a "$USER" -s "$SERVICE" -w)"
    if [[ ${#k2} -ne $n ]]; then
      unset k2
      print -u2 -- "Stored length differs from the copied key; nothing is trusted. Retry."
      exit 74
    fi
    unset k2
    print -- "Stored in the login Keychain ($n characters); clipboard cleared. Next: $SCRIPT verify-key-scope"
    ;;
  key-status)
    [[ $# -eq 1 ]] || usage
    if key_present; then print -- present; else print -- absent; fi
    ;;
  verify-key-scope)
    # Cost-free checks only: two reads, and two generation endpoints called with a
    # real model and an EMPTY input, which can never produce (or bill) anything.
    # The tunnel read must succeed; everything else must be refused for missing
    # scopes. A 401 invalid_api_key anywhere means the stored key is wrong.
    [[ $# -eq 1 ]] || usage
    [[ -f "$PROFILE" ]] || { print -u2 -- "Missing profile; run install-profile first."; exit 1; }
    tunnel_id="$(awk -F'"' '/tunnel_id:/ {print $2; exit}' "$PROFILE")"
    [[ "$tunnel_id" =~ '^tunnel_[0-9a-f]{32}$' ]] || { print -u2 -- "No tunnel id in the profile."; exit 1; }
    load_key || exit $?
    k=$CONTROL_PLANE_API_KEY
    unset CONTROL_PLANE_API_KEY
    classify() {
      # The API answers errors both as {"error": {...}} and as {"error": "<text>"}.
      "$PYTHON" -c '
import json, sys
text = sys.stdin.read().rstrip("\n")
body, _, code = text.rpartition("\n")
try:
    error = json.loads(body).get("error")
except Exception:
    error = None
if isinstance(error, dict):
    message, error_code = str(error.get("message", "")), error.get("code")
elif isinstance(error, str):
    message, error_code = error, None
else:
    message, error_code = "", None
if error_code == "invalid_api_key" or "Incorrect API key" in message:
    kind = "invalid_key"
elif error_code == "missing_scope" or "Missing scopes" in message or "insufficient permissions" in message.lower():
    kind = "missing_scopes"
elif error is not None:
    kind = "error"
else:
    kind = "ok"
print(code, kind)
'
    }
    probe() {  # method, url, optional JSON body
      if [[ $# -eq 3 ]]; then
        printf 'Authorization: Bearer %s\nContent-Type: application/json\n' "$k" |
          curl --noproxy '*' -sS -m 15 -X "$1" -d "$3" -w '\n%{http_code}' -H @- "$2" 2>/dev/null | classify
      else
        printf 'Authorization: Bearer %s\n' "$k" |
          curl --noproxy '*' -sS -m 15 -X "$1" -w '\n%{http_code}' -H @- "$2" 2>/dev/null | classify
      fi
    }
    tunnel_result="$(probe GET "https://api.openai.com/v1/tunnels/$tunnel_id")" || tunnel_result="000 error"
    models_result="$(probe GET https://api.openai.com/v1/models)" || models_result="000 error"
    chat_result="$(probe POST https://api.openai.com/v1/chat/completions '{"model":"gpt-4o-mini","messages":[]}')" || chat_result="000 error"
    responses_result="$(probe POST https://api.openai.com/v1/responses '{"model":"gpt-4o-mini","input":[]}')" || responses_result="000 error"
    unset k
    print -- "tunnel metadata:          HTTP ${tunnel_result% *} (${tunnel_result#* })"
    print -- "model list:               HTTP ${models_result% *} (${models_result#* })"
    print -- "chat completions (empty): HTTP ${chat_result% *} (${chat_result#* })"
    print -- "responses (empty):        HTTP ${responses_result% *} (${responses_result#* })"
    all="$tunnel_result $models_result $chat_result $responses_result"
    if [[ "$all" == *invalid_key* ]]; then
      print -- "INVALID KEY: OpenAI does not recognise the stored key (incomplete copy?). Store it again with key-store."
      exit 5
    fi
    if [[ "${tunnel_result% *}" != 200 ]]; then
      print -- "The key cannot read this tunnel (needs Tunnels Read + Use on the tunnel's organisation)."
      exit 6
    fi
    for result in "$models_result" "$chat_result" "$responses_result"; do
      if [[ "$result" != *missing_scopes* ]]; then
        print -- "NOT PROVEN RESTRICTED: a model endpoint was not refused for missing scopes ($result); do not start the tunnel."
        exit 3
      fi
    done
    print -- "OK: the key reads its tunnel and every model endpoint refuses it for missing scopes (it cannot spend on tokens)."
    ;;
  doctor)
    [[ $# -eq 1 ]] || usage
    require_setup || exit $?
    load_key || exit $?
    exec "$CLIENT" doctor --profile nousos-read --explain
    ;;
  run|launchd-run)
    [[ $# -eq 1 ]] || usage
    if [[ "$1" == launchd-run ]] && ! key_present; then
      print -u2 -- "Keychain item absent; add it, then start the job again."
      exit 0
    fi
    require_setup || exit $?
    if [[ "$1" == run ]]; then
      loaded && {
        print -u2 -- "The launchd job is loaded; use stop first."
        exit 1
      }
      print -- "Starting tunnel-client in this Terminal; Ctrl-C stops it."
    else
      if [[ ! -f "$SESSION_ID_FILE" ]]; then
        print -u2 -- "On-demand session id missing."
        exit 0
      fi
      NOUSOS_TUNNEL_SESSION="$(<"$SESSION_ID_FILE")"
      if [[ ! "$NOUSOS_TUNNEL_SESSION" =~ '^[A-Za-z0-9_.-]{1,64}$' ]]; then
        print -u2 -- "Invalid on-demand session id."
        exit 0
      fi
      export NOUSOS_TUNNEL_SESSION
    fi
    require_no_client || exit 1
    load_key || exit $?
    exec_locked_client
    ;;
  start)
    idle_minutes=20
    max_minutes=120
    presence=no
    away_minutes=30
    max_hours=12
    seen_idle=no
    seen_max=no
    seen_for=no
    seen_away=no
    seen_hours=no
    shift
    [[ "${1:-}" == --_lock-held ]] && shift
    while (( $# > 0 )); do
      option=$1
      shift
      if [[ "$option" == --presence ]]; then
        [[ "$presence" == no ]] || usage
        presence=yes
        continue
      fi
      (( $# > 0 )) || usage
      value=$1
      shift
      case "$option" in
        --idle)
          [[ "$value" =~ '^[1-9][0-9]{0,2}$' && "$value" -le 240 ]] || usage
          [[ "$seen_idle" == no && "$seen_for" == no ]] || usage
          idle_minutes=$value
          seen_idle=yes
          ;;
        --max)
          [[ "$value" =~ '^[1-9][0-9]{0,2}$' && "$value" -le 240 ]] || usage
          [[ "$seen_max" == no && "$seen_for" == no ]] || usage
          max_minutes=$value
          seen_max=yes
          ;;
        --for)
          [[ "$value" =~ '^[1-9][0-9]{0,2}$' && "$value" -le 240 ]] || usage
          [[ "$seen_for" == no && "$seen_idle" == no && "$seen_max" == no ]] || usage
          idle_minutes=0
          max_minutes=$value
          seen_for=yes
          ;;
        --away)
          [[ "$seen_away" == no && "$value" =~ '^[1-9][0-9]{0,2}$' && "$value" -ge 5 && "$value" -le 120 ]] || usage
          away_minutes=$value
          seen_away=yes
          ;;
        --max-hours)
          [[ "$seen_hours" == no && "$value" =~ '^[1-9][0-9]?$' && "$value" -ge 1 && "$value" -le 16 ]] || usage
          max_hours=$value
          seen_hours=yes
          ;;
        *) usage ;;
      esac
    done
    if [[ "$presence" == yes ]]; then
      [[ "$seen_idle" == no && "$seen_max" == no && "$seen_for" == no ]] || usage
      idle_minutes=$away_minutes
      max_minutes=$(( max_hours * 60 ))
    else
      [[ "$seen_away" == no && "$seen_hours" == no ]] || usage
    fi
    [[ -f "$WATCHDOG" ]] || { print -u2 -- "Missing watchdog: $WATCHDOG"; exit 1; }
    [[ ! -f "$AUTOSTART_PLIST" ]] || {
      print -u2 -- "An old login autostart is installed; run disable-autostart first."
      exit 1
    }
    require_setup || exit $?
    loaded && {
      print -u2 -- "The launchd job is already loaded."
      exit 1
    }
    require_no_client || exit 1
    prepare_runtime_dirs
    launchctl bootout "$WATCHDOG_JOB" >/dev/null 2>&1 || true

    start_epoch="$(date -u +%s)"
    random_hex="$(od -An -N2 -tx1 /dev/urandom | tr -d ' \n')"
    session="s$(date -u +%Y%m%d%H%M%S)-$random_hex"
    idle_seconds=$(( idle_minutes * 60 ))
    max_seconds=$(( max_minutes * 60 ))

    tmp="$(mktemp "$STATEDIR/.session.id.XXXXXXXX")"
    chmod 600 "$tmp"
    printf '%s\n' "$session" > "$tmp"
    mv -f "$tmp" "$SESSION_ID_FILE"

    tmp="$(mktemp "$STATEDIR/.watchdog.state.XXXXXXXX")"
    chmod 600 "$tmp"
    "$PYTHON" "$STATE_HELPER" write "$tmp" "$session" "$start_epoch" "$idle_seconds" "$max_seconds" "$presence" "$(( away_minutes * 60 ))"
    mv -f "$tmp" "$WATCHDOG_STATE"

    cat > "$WATCHDOG_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$WATCHDOG_LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$PYTHON</string>
    <string>$WATCHDOG</string>
    <string>--session</string><string>$session</string>
    <string>--start-epoch</string><string>$start_epoch</string>
    <string>--idle-seconds</string><string>$idle_seconds</string>
    <string>--max-seconds</string><string>$max_seconds</string>
EOF
    if [[ "$presence" == yes ]]; then
      cat >> "$WATCHDOG_PLIST" <<EOF
    <string>--presence-away-seconds</string><string>$(( away_minutes * 60 ))</string>
EOF
    fi
    cat >> "$WATCHDOG_PLIST" <<EOF
    <string>--log-dir</string><string>$LOGDIR</string>
    <string>--stop-command</string><string>$SCRIPT</string>
    <string>--interval</string><string>30</string>
    <string>--self-label</string><string>$WATCHDOG_LABEL</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$LOGDIR/watchdog.log</string>
  <key>StandardErrorPath</key><string>$LOGDIR/watchdog.log</string>
</dict>
</plist>
EOF
    chmod 600 "$WATCHDOG_PLIST"
    if ! plutil -lint "$WATCHDOG_PLIST" >/dev/null; then
      cleanup_failed_start
      print -u2 -- "Watchdog plist failed plutil -lint; not starting."
      exit 1
    fi
    if ! launchctl bootstrap "gui/$UID" "$WATCHDOG_PLIST"; then
      cleanup_failed_start
      print -u2 -- "Watchdog not loaded; not starting."
      exit 1
    fi
    if ! render_plist "$SESSION_PLIST" 600; then
      cleanup_failed_start
      exit 1
    fi
    if ! launchctl print "$WATCHDOG_JOB" >/dev/null 2>&1; then
      cleanup_failed_start
      print -u2 -- "Watchdog exited before tunnel bootstrap; not starting."
      exit 1
    fi
    if ! launchctl bootstrap "gui/$UID" "$SESSION_PLIST"; then
      cleanup_failed_start
      print -u2 -- "Tunnel bootstrap failed."
      exit 1
    fi
    if ! launchctl print "$WATCHDOG_JOB" >/dev/null 2>&1; then
      do_stop || true
      cleanup_failed_start
      print -u2 -- "Watchdog is not loaded; tunnel stopped."
      exit 1
    fi
    print -- "watchdog: session $session; idle $idle_minutes min; max $max_minutes min"
    integer i=0
    while (( i < 60 )); do
      code="$(ready_code)"
      if [[ "$code" == 200 ]]; then
        rm -f "$MANUAL_STOP"
        print -- "ready (HTTP 200)"
        exit 0
      fi
      sleep 1
      (( i += 1 ))
    done
    print -- "not-ready (HTTP $code)"
    exit 1
    ;;
  stop)
    # A manual stop cancels the watchdog; its own call must not boot itself out.
    if [[ $# -ge 2 && "$2" == --from-watchdog ]]; then
      state_mode=idle
      [[ -f "$WATCHDOG_STATE" ]] && state_mode="$(sed -n '5p' "$WATCHDOG_STATE")"
      do_stop
      rm -f "$SESSION_ID_FILE" "$WATCHDOG_STATE"
      reason=idle
      if [[ $# -eq 4 && "$3" == --reason && "$4" =~ '^(idle|away|max)$' ]]; then reason=$4; fi
      if [[ "$state_mode" == presence ]]; then notify_state stopped "$reason" 'start --presence'; else notify_state stopped "$reason"; fi
    elif [[ $# -eq 1 ]]; then
      state_mode=idle
      [[ -f "$WATCHDOG_STATE" ]] && state_mode="$(sed -n '5p' "$WATCHDOG_STATE")"
      prepare_runtime_dirs
      : > "$MANUAL_STOP"
      do_stop
      if launchctl print "$WATCHDOG_JOB" >/dev/null 2>&1; then
        launchctl bootout "$WATCHDOG_JOB" >/dev/null 2>&1 || true
        print -- "watchdog cancelled"
      fi
      rm -f "$SESSION_ID_FILE" "$WATCHDOG_STATE"
      if [[ "$state_mode" == presence ]]; then notify_state stopped manual 'start --presence'; else notify_state stopped manual; fi
    else
      usage
    fi
    ;;
  presence-enable)
    [[ $# -eq 1 ]] || usage
    mkdir -p "$HOME/Library/LaunchAgents"
    prepare_runtime_dirs
    cat > "$PRESENCE_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$PRESENCE_LABEL</string>
  <key>ProgramArguments</key><array><string>$SCRIPT</string><string>presence-tick</string></array>
  <key>StartInterval</key><integer>60</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$LOGDIR/presence.log</string>
  <key>StandardErrorPath</key><string>$LOGDIR/presence.log</string>
</dict></plist>
EOF
    chmod 600 "$PRESENCE_PLIST"
    plutil -lint "$PRESENCE_PLIST" >/dev/null || { rm -f "$PRESENCE_PLIST"; exit 1; }
    launchctl bootout "$PRESENCE_JOB" >/dev/null 2>&1 || true
    launchctl bootstrap "gui/$UID" "$PRESENCE_PLIST"
    print -- "Presence keeper enabled (checks every 60 seconds)."
    ;;
  presence-disable)
    [[ $# -eq 1 ]] || usage
    launchctl bootout "$PRESENCE_JOB" >/dev/null 2>&1 || true
    rm -f "$PRESENCE_PLIST"
    print -- "Presence keeper disabled."
    ;;
  presence-tick)
    [[ $# -eq 1 ]] || usage
    if ! "$PYTHON" "$LOCK_HELPER" check "$START_LOCK" >/dev/null 2>&1; then exit 0; fi
    session_running=no
    if loaded || has_client; then session_running=yes; fi
    setup_complete=no
    if require_setup >/dev/null 2>&1; then setup_complete=yes; fi
    idle_value="$(hid_idle_seconds)" || idle_value=
    helper_args=()
    [[ "$session_running" == yes ]] && helper_args+=(--session-running)
    [[ -f "$MANUAL_STOP" ]] && helper_args+=(--manual-stop)
    [[ -n "$idle_value" ]] && helper_args+=(--idle-seconds "$idle_value")
    [[ "$setup_complete" == yes ]] && helper_args+=(--setup-complete)
    decision="$("$PYTHON" "$PRESENCE_HELPER" $helper_args)" || exit 1
    if [[ "$decision" == start ]]; then
      if "$SCRIPT" start --presence >/dev/null 2>&1; then notify_state started presence; fi
    fi
    ;;
  presence-resume)
    [[ $# -eq 1 ]] || usage
    rm -f "$MANUAL_STOP"
    "$SCRIPT" presence-tick
    ;;
  status)
    [[ $# -eq 1 ]] || usage
    if loaded; then
      launchctl print "$JOB" | awk '
        $1 == "state" && $2 == "=" && !s++ {print "launchd state: " $3}
        $1 == "pid" && $2 == "=" && !p++ {print "launchd PID: " $3}
      '
    else
      print -- "launchd: not loaded"
    fi
    if launchctl print "$WATCHDOG_JOB" >/dev/null 2>&1; then
      print -- "watchdog: loaded ($WATCHDOG_PLIST)"
      if [[ -f "$WATCHDOG_STATE" ]]; then
        state_text="$("$PYTHON" "$STATE_HELPER" read "$WATCHDOG_STATE")" || state_text=
        state_lines=(${(f)state_text})
        state_session=${state_lines[1]:-}
        state_start=${state_lines[2]:-}
        state_idle=${state_lines[3]:-}
        state_max=${state_lines[4]:-}
        state_mode=${state_lines[5]:-}
        state_away=${state_lines[6]:-}
        if [[ "$state_session" =~ '^[A-Za-z0-9_.-]{1,64}$' &&
              "$state_start" =~ '^[0-9]+$' &&
              "$state_idle" =~ '^[0-9]+$' &&
              "$state_max" =~ '^[0-9]+$' &&
              ("$state_mode" == idle || ("$state_mode" == presence && "$state_away" =~ '^[0-9]+$')) ]]; then
          status_args=(--status
            --session "$state_session" \
            --start-epoch "$state_start" \
            --idle-seconds "$state_idle" \
            --max-seconds "$state_max" \
            --log-dir "$LOGDIR")
          [[ "$state_mode" == presence ]] && status_args+=(--presence-away-seconds "$state_away")
          "$PYTHON" "$WATCHDOG" $status_args
        else
          print -- "watchdog state: invalid"
        fi
      else
        print -- "watchdog state: unavailable"
      fi
    else
      print -- "watchdog: none"
    fi
    if [[ -f "$AUTOSTART_PLIST" ]]; then
      print -- "autostart installed: yes"
    else
      print -- "autostart installed: no"
    fi
    if [[ -f "$PRESENCE_PLIST" ]]; then print -- "presence keeper installed: yes"; else print -- "presence keeper installed: no"; fi
    print -- "readyz HTTP: $(ready_code)"
    print -- "health status:"
    if ! curl --noproxy '*' -fsS -m 2 "$HEALTH/health?details=true" 2>/dev/null |
      "$PYTHON" -c '
import json
import sys
try:
    data = json.load(sys.stdin)
    out = {k: data[k] for k in ("live", "ready") if k in data}
    out["components"] = {
        name: {k: value[k] for k in ("status", "state", "reason_code")
               if k in value}
        for name, value in data.get("components", {}).items()
    }
    print(json.dumps(out, sort_keys=True))
except Exception:
    print("unavailable")
    sys.exit(1)
'; then
      :
    fi
    day="$(date -u +%Y%m%d)"
    gate_log="$LOGDIR/gate-$day.ndjson"
    print -- "gate decisions today:"
    if [[ -f "$gate_log" ]]; then
      "$PYTHON" -c '
import collections
import json
import sys
counts = collections.Counter()
with open(sys.argv[1], encoding="utf-8") as stream:
    for line in stream:
        try:
            decision = json.loads(line).get("decision")
        except (ValueError, TypeError):
            continue
        if isinstance(decision, str):
            counts[decision] += 1
print(json.dumps(dict(sorted(counts.items())), sort_keys=True))
' "$gate_log"
    else
      print -- '{}'
    fi
    count="$(matching_pids client | awk 'END {print NR+0}')"
    print -- "matching tunnel-client instances: $count"
    if (( count > 1 )); then print -- "WARNING: duplicate instances"; fi
    if [[ -x "$CLIENT" ]]; then
      "$CLIENT" --version
    else
      print -- "tunnel-client: missing"
    fi
    print -- "profile: $PROFILE"
    if key_present; then print -- "key: present"; else print -- "key: absent"; fi
    ;;
  disable-autostart)
    [[ $# -eq 1 ]] || usage
    if [[ -f "$AUTOSTART_PLIST" ]]; then
      if loaded_from "$AUTOSTART_PLIST"; then
        do_stop
      fi
      rm -f "$AUTOSTART_PLIST"
    fi
    print -- "Autostart disabled."
    ;;
  logs)
    [[ $# -le 2 ]] || usage
    n="${2:-50}"
    [[ "$n" =~ '^[1-9][0-9]*$' ]] || usage
    for file in "$LOGDIR/tunnel-client.ndjson" "$LOGDIR/launchd.out.log" "$LOGDIR/launchd.err.log"; do
      print -- "== $file =="
      if [[ -f "$file" ]]; then tail -n "$n" "$file"; else print -- "(absent)"; fi
    done
    ;;
  rollback)
    delete_key=no
    remove_client=no
    shift
    for option in "$@"; do
      case "$option" in
        --delete-key) delete_key=yes ;;
        --remove-client) remove_client=yes ;;
        *) usage ;;
      esac
    done
    if [[ "$remove_client" == yes ]]; then
      if [[ -z "${NOUSOS_TUNNEL_CLIENT_HOME:-}" ]]; then
        print -u2 -- "Set NOUSOS_TUNNEL_CLIENT_HOME to the tunnel-client install directory before using --remove-client."
        exit 1
      fi
      if [[ "$NOUSOS_TUNNEL_CLIENT_HOME" == / || "$NOUSOS_TUNNEL_CLIENT_HOME" == "$HOME" || ! -d "$NOUSOS_TUNNEL_CLIENT_HOME" ]]; then
        print -u2 -- "NOUSOS_TUNNEL_CLIENT_HOME must name an existing directory other than / or your home directory."
        exit 1
      fi
    fi
    if ! do_stop; then
      print -u2 -- "Rollback aborted: matching processes are still running."
      exit 1
    fi
    launchctl bootout "$WATCHDOG_JOB" >/dev/null 2>&1 || true
    launchctl bootout "$PRESENCE_JOB" >/dev/null 2>&1 || true
    rm -f "$PRESENCE_PLIST" "$MANUAL_STOP"
    rm -f "$SESSION_ID_FILE" "$WATCHDOG_STATE" "$WATCHDOG_PLIST"
    if [[ -f "$AUTOSTART_PLIST" ]]; then rm -f "$AUTOSTART_PLIST"; fi
    rm -f "$SESSION_PLIST"
    mkdir -p "$STATEDIR"
    chmod 700 "$STATEDIR"
    if [[ -f "$PROFILE" ]]; then
      mv "$PROFILE" "$STATEDIR/nousos-read.yaml.rollback-$(date -u +%Y%m%dT%H%M%SZ)-$$"
    fi
    if [[ "$delete_key" == yes ]] && key_present; then
      security delete-generic-password -a "$USER" -s "$SERVICE"
    fi
    if [[ "$remove_client" == yes ]]; then
      rm -f "$CLIENT"
      rm -rf "$NOUSOS_TUNNEL_CLIENT_HOME"
    fi
    print -- 'Passi UI rimanenti: revoca la chiave runtime nella pagina Platform API keys; facoltativamente elimina il tunnel nella pagina Platform Tunnels; rimuovi la app da chatgpt.com/plugins.'
    ;;
  *) usage ;;
esac
