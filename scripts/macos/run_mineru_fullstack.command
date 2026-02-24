#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
API_HOST="${API_HOST:-127.0.0.1}"
API_PORT="${API_PORT:-8000}"
WEB_HOST="${WEB_HOST:-127.0.0.1}"
WEB_PORT="${WEB_PORT:-7860}"
LOG_DIR="${LOG_DIR:-$ROOT_DIR/.run_logs}"
VENV_DIR="${VENV_DIR:-$ROOT_DIR/.venv-launcher}"
PYTHON_SPEC="${PYTHON_SPEC:-3.11}"

pick_uv_python() {
  if [[ -n "${PYTHON_SPEC:-}" ]]; then
    echo "$PYTHON_SPEC"
    return
  fi

  if command -v python3.12 >/dev/null 2>&1; then
    echo "3.12"
    return
  fi

  if command -v python3.11 >/dev/null 2>&1; then
    echo "3.11"
    return
  fi

  echo "3.10"
}

ensure_launcher_venv() {
  if ! command -v uv >/dev/null 2>&1; then
    return 1
  fi

  if [[ ! -x "$VENV_DIR/bin/python" ]]; then
    echo "Creating launcher virtualenv at $VENV_DIR"
    if ! uv venv --python "$(pick_uv_python)" "$VENV_DIR" >/dev/null 2>&1; then
      uv venv --python 3.12 "$VENV_DIR" >/dev/null 2>&1
    fi
  fi

  if ! "$VENV_DIR/bin/python" -c "import mineru, gradio, uvicorn" >/dev/null 2>&1; then
    echo "Installing MinerU dependencies into launcher virtualenv..."
    uv pip install --python "$VENV_DIR/bin/python" -e ".[all]" >/dev/null
  fi

  return 0
}

mkdir -p "$LOG_DIR"

API_LOG="$LOG_DIR/mineru-api.log"
WEB_LOG="$LOG_DIR/mineru-gradio.log"

pick_api_cmd() {
  if ensure_launcher_venv; then
    API_CMD=("$VENV_DIR/bin/mineru-api" --host "$API_HOST" --port "$API_PORT")
    return
  fi

  if command -v mineru-api >/dev/null 2>&1; then
    API_CMD=(mineru-api --host "$API_HOST" --port "$API_PORT")
    return
  fi

  if command -v uv >/dev/null 2>&1; then
    API_CMD=(uv run --python "$(pick_uv_python)" mineru-api --host "$API_HOST" --port "$API_PORT")
    return
  fi

  if command -v python3 >/dev/null 2>&1; then
    API_CMD=(python3 -m mineru.cli.fast_api --host "$API_HOST" --port "$API_PORT")
    return
  fi

  echo "Cannot find uv/mineru-api/python3. Install dependencies first." >&2
  exit 1
}

pick_web_cmd() {
  if ensure_launcher_venv; then
    WEB_CMD=("$VENV_DIR/bin/mineru-gradio" --server-name "$WEB_HOST" --server-port "$WEB_PORT")
    return
  fi

  if command -v mineru-gradio >/dev/null 2>&1; then
    WEB_CMD=(mineru-gradio --server-name "$WEB_HOST" --server-port "$WEB_PORT")
    return
  fi

  if command -v uv >/dev/null 2>&1; then
    WEB_CMD=(uv run --python "$(pick_uv_python)" mineru-gradio --server-name "$WEB_HOST" --server-port "$WEB_PORT")
    return
  fi

  if command -v python3 >/dev/null 2>&1; then
    WEB_CMD=(python3 -m mineru.cli.gradio_app --server-name "$WEB_HOST" --server-port "$WEB_PORT")
    return
  fi

  echo "Cannot find uv/mineru-gradio/python3. Install dependencies first." >&2
  exit 1
}

run_cmd() {
  local out_pid_var="$1"
  local log_file="$2"
  shift 2
  (
    cd "$ROOT_DIR"
    "$@"
  ) >"$log_file" 2>&1 &
  printf -v "$out_pid_var" '%s' "$!"
}

cleanup() {
  set +e
  if [[ -n "${WEB_PID:-}" ]] && kill -0 "$WEB_PID" >/dev/null 2>&1; then
    kill "$WEB_PID" >/dev/null 2>&1
  fi
  if [[ -n "${API_PID:-}" ]] && kill -0 "$API_PID" >/dev/null 2>&1; then
    kill "$API_PID" >/dev/null 2>&1
  fi
}

trap cleanup EXIT INT TERM

pick_api_cmd
pick_web_cmd

echo "Starting MinerU API..."
run_cmd API_PID "$API_LOG" "${API_CMD[@]}"
sleep 2
if ! kill -0 "$API_PID" >/dev/null 2>&1; then
  echo "API start failed. Check log: $API_LOG" >&2
  exit 1
fi

echo "Starting MinerU Gradio..."
run_cmd WEB_PID "$WEB_LOG" "${WEB_CMD[@]}"
sleep 2
if ! kill -0 "$WEB_PID" >/dev/null 2>&1; then
  echo "Gradio start failed. Check log: $WEB_LOG" >&2
  exit 1
fi

echo
echo "MinerU stack is running"
echo "- API:    http://$API_HOST:$API_PORT/docs"
echo "- Gradio: http://$WEB_HOST:$WEB_PORT"
echo "- Logs:   $LOG_DIR"
echo
echo "Press Ctrl+C to stop both services."

wait "$API_PID" "$WEB_PID"
