#!/bin/sh
# Generate the MCP server config at runtime so Browse can be toggled via .env
# without rebuilding. Playwright is always enabled (self-contained headless).
set -e
CFG=/root/.config/opencode/opencode.jsonc
mkdir -p "$(dirname "$CFG")"

if [ "${ENABLE_BROWSE:-0}" = "1" ] || [ "${ENABLE_BROWSE:-0}" = "true" ]; then
  cat > "$CFG" <<'JSONC'
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "browse": {
        "type": "local",
        "command": ["browse", "mcp"],
        "codemode": false,
        "disabled": false
      },
      "playwright": {
        "type": "local",
        "command": ["playwright-mcp", "--headless", "--no-sandbox", "--browser", "chromium", "--caps", "devtools,vision"],
        "disabled": false
      }
    }
  }
}
JSONC
  echo "[entrypoint] Browse + Playwright MCP enabled"
else
  cat > "$CFG" <<'JSONC'
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "playwright": {
        "type": "local",
        "command": ["playwright-mcp", "--headless", "--no-sandbox", "--browser", "chromium", "--caps", "devtools,vision"],
        "disabled": false
      }
    }
  }
}
JSONC
  echo "[entrypoint] Browse disabled; Playwright MCP enabled"
fi

exec "$@"
