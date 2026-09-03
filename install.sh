#!/usr/bin/env bash
set -e

# ================================================================
#         Oh My Pi Antigravity Pro - One-Line Installer (POSIX)
# ================================================================

CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

info() { echo -e "${CYAN}[omp-antigravity-pro] $1${NC}"; }
success() { echo -e "${GREEN}[omp-antigravity-pro] $1${NC}"; }
warn() { echo -e "${YELLOW}[omp-antigravity-pro] WARNING: $1${NC}"; }
err() { echo -e "${RED}[omp-antigravity-pro] ERROR: $1${NC}"; }

echo ""
echo -e "${CYAN}================================================================${NC}"
echo -e "${CYAN}         Oh My Pi Antigravity Pro - One-Line Installer          ${NC}"
echo -e "${CYAN}================================================================${NC}"
echo ""

OMP_DIR="${HOME}/.omp"
PLUGINS_DIR="${OMP_DIR}/plugins"

mkdir -p "${PLUGINS_DIR}"

PKG_JSON="${PLUGINS_DIR}/package.json"
if [ ! -f "${PKG_JSON}" ]; then
  echo '{"name":"omp-plugins","private":true,"dependencies":{}}' > "${PKG_JSON}"
fi

HAS_BUN=false
HAS_NPM=false
HAS_OMP=false
INSTALL_SUCCESS=false

command -v bun >/dev/null 2>&1 && HAS_BUN=true
command -v npm >/dev/null 2>&1 && HAS_NPM=true
command -v omp >/dev/null 2>&1 && HAS_OMP=true

if [ "$HAS_BUN" = true ] && [ "$HAS_OMP" = true ]; then
  info "Bun detected. Installing via 'omp plugin install'..."
  if omp plugin install github:ART1KZ/omp-antigravity-pro --force; then
    INSTALL_SUCCESS=true
  else
    warn "Native OMP installer encountered an issue, falling back to direct npm install..."
  fi
fi

if [ "$INSTALL_SUCCESS" = false ] && [ "$HAS_NPM" = true ]; then
  info "Using npm to install directly into '${PLUGINS_DIR}' (no Bun required)..."
  if npm --prefix "${PLUGINS_DIR}" install github:ART1KZ/omp-antigravity-pro --no-fund --no-audit; then
    INSTALL_SUCCESS=true
  else
    warn "npm install failed."
  fi
fi

if [ "$INSTALL_SUCCESS" = false ] && [ "$HAS_BUN" = false ] && [ "$HAS_NPM" = false ]; then
  info "Neither Bun nor npm detected. Bootstrapping Bun automatically..."
  curl -fsSL https://bun.sh/install | bash || true
  export PATH="${HOME}/.bun/bin:${PATH}"
  if command -v bun >/dev/null 2>&1; then
    if [ "$HAS_OMP" = true ]; then
      omp plugin install github:ART1KZ/omp-antigravity-pro --force && INSTALL_SUCCESS=true
    else
      bun install --cwd "${PLUGINS_DIR}" github:ART1KZ/omp-antigravity-pro && INSTALL_SUCCESS=true
    fi
  fi
fi

PLUGIN_PATH="${PLUGINS_DIR}/node_modules/omp-antigravity-pro"
if [ -d "${PLUGIN_PATH}" ] || [ "$INSTALL_SUCCESS" = true ]; then
  echo ""
  echo -e "${GREEN}================================================================${NC}"
  echo -e "${GREEN} [OK] omp-antigravity-pro successfully installed and ready!     ${NC}"
  echo -e "${GREEN}================================================================${NC}"
  echo ""
  echo "Usage guide:"
  echo "  1. Verify installed models:"
  echo "     omp models google-antigravity"
  echo ""
  echo "  2. Run Gemini Flash with thinking budget:"
  echo "     omp --model google-antigravity/gemini-3.6-flash --thinking medium"
  echo "     omp --model google-antigravity/gemini-3.7-flash --thinking high"
  echo "     omp --model google-antigravity/gemini-3.8-flash --thinking high"
  echo ""
  echo "  3. Log in or switch accounts anytime:"
  echo "     omp /login  (select Google Antigravity)"
  echo ""
else
  err "Installation could not be completed automatically."
  echo "Try running manually in your terminal:"
  echo "  npm --prefix \"${PLUGINS_DIR}\" install github:ART1KZ/omp-antigravity-pro"
  exit 1
fi
