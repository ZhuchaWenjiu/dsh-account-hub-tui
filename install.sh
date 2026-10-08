#!/usr/bin/env bash
# dsh-codearts-auth 一键安装脚本。
#
# 作用：把 CodeArts（华为云）登录插件装到指定 dsh profile，并自动处理
#       pnpm 10 / 11 的 allowBuilds 放行键差异（两代互不兼容，写错就装不上）。
#
# 用法：
#   bash install.sh                      # 装到默认 profile dsh-tui
#   PROFILE=headless bash install.sh     # 装到指定 profile
#   REPO=<git-url> bash install.sh       # 从指定仓库安装（默认本仓库 origin）
#   LOCAL=1 bash install.sh              # 本地源码 link 安装（开发用，需先 build）
#
# 前置：Node.js ≥ 20、pnpm ≥ 10、已安装 dsh。
set -euo pipefail

PROFILE="${PROFILE:-}"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PKG_NAME="dsh-codearts-auth"

# 本仓库地址：优先从 git remote 推断（在克隆目录里运行时），否则用默认值。
SELF_REPO="${REPO:-}"
if [ -z "$SELF_REPO" ]; then
  SELF_REPO="$(git -C "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)" remote get-url origin 2>/dev/null || true)"
fi
SELF_REPO="${SELF_REPO:-https://github.com/Zhuchawenjiu/dsh-account-hub-tui.git}"

# 未指定 profile 时，不猜默认值——列出可选 profile 并要求显式指定。
# （脚本会改写 profile 的 pnpm-workspace.yaml，误跑到正在使用的 profile 上
#   会动到活动配置，故必须显式确认。）
if [ -z "$PROFILE" ]; then
  echo "==> $PKG_NAME 安装器"
  echo "未指定 PROFILE。可用的 profile："
  ls -1 "$DSH_HOME/profiles" 2>/dev/null | grep -v '^node_modules$' | sed 's/^/    - /'
  echo
  echo "用法：PROFILE=<name> bash install.sh"
  exit 1
fi
WORKSPACE_YAML="$DSH_HOME/profiles/$PROFILE/pnpm-workspace.yaml"

echo "==> $PKG_NAME 安装器（profile: $PROFILE）"

[ -d "$DSH_HOME/profiles/$PROFILE" ] || { echo "profile '$PROFILE' 不存在：$DSH_HOME/profiles/$PROFILE"; exit 1; }

for cmd in dsh pnpm node; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "缺少 $cmd，请先安装（Node.js ≥ 20 + pnpm ≥ 10）"; exit 1; }
done

PNPM_MAJOR="$(pnpm --version 2>/dev/null | cut -d. -f1)"
echo "==> 检测到 pnpm ${PNPM_MAJOR}.x"

# ───────────────────────────────────────────────────────────────
# 本地源码 link 安装（LOCAL=1 或 LOCAL=<path>）
# ───────────────────────────────────────────────────────────────
if [ -n "${LOCAL:-}" ]; then
  SRC_DIR="$LOCAL"
  [ "$SRC_DIR" = "1" ] && SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  echo "==> 本地源码安装：$SRC_DIR"

  # link: 依赖不会跑 prepare，必须手动构建，否则 dsh 启动报
  # ERR_MODULE_NOT_FOUND: .../lib/index.js
  echo "==> 构建 lib/（build:all，含 client 产物）..."
  ( cd "$SRC_DIR" && pnpm build:all )

  echo "==> 安装为 link: 依赖 ..."
  CI=true dsh plugin --profile "$PROFILE" install "$SRC_DIR"

  echo "✅ 本地安装完成。"
  echo "   注意：每次修改 src/ 或 plugin-src/ 后需重新 pnpm build:all。"
  exit 0
fi

# ───────────────────────────────────────────────────────────────
# git 安装：先探测 pnpm 期望的 allowBuilds 键
# ───────────────────────────────────────────────────────────────
echo "==> 第 1 次安装（预期失败，用于获取 pnpm 期望的 allowBuilds 键）..."
set +e
PROBE_OUT="$(CI=true dsh plugin --profile "$PROFILE" add "$SELF_REPO" 2>&1)"
PROBE_RC=$?
set -e
echo "$PROBE_OUT" | sed 's/^/    | /'

# 已经成功（说明此前已放行过），直接收尾。
if [ "$PROBE_RC" -eq 0 ] && ! echo "$PROBE_OUT" | grep -qE 'ERR_PNPM_(GIT_DEP_PREPARE_NOT_ALLOWED|INVALID_VERSION_UNION)'; then
  echo "✅ 安装完成（无需额外放行）。"
  exit 0
fi

# 从 pnpm 报错里提取它期望的精确键。
# ⚠️ 键格式随 pnpm 版本变化，实测见过三种形态，必须都能认：
#   pnpm 11.7.0  : dsh-codearts-auth@git+https://github.com/...#<sha>
#   pnpm 11.28.1 : dsh-codearts-auth@https://codeload.github.com/.../tar.gz/<sha>
#   pnpm 10.x    : 不打印可复制的键（该分支只用纯包名）
# 故不写死前缀，改为「抓 pnpm 建议块里以 ': true' 结尾的那一行」。
extract_want_key() {
  local k
  # 优先取形如 "  <key>: true" 的建议行（pnpm 自己给的示例，最可靠）
  k="$(printf '%s\n' "$PROBE_OUT" \
      | grep -oE "[[:space:]]${PKG_NAME}@[^[:space:]]+:[[:space:]]*true[[:space:]]*$" \
      | head -1 | sed -E 's/^[[:space:]]+//; s/:[[:space:]]*true[[:space:]]*$//')"
  [ -n "$k" ] && { printf '%s' "$k"; return 0; }
  # 退而求其次：行内任意位置的 "pkg@<非空白>: true"
  k="$(printf '%s\n' "$PROBE_OUT" \
      | grep -oE "${PKG_NAME}@[^[:space:]]+:[[:space:]]*true" \
      | head -1 | sed -E 's/:[[:space:]]*true$//')"
  [ -n "$k" ] && { printf '%s' "$k"; return 0; }
  # 最后：含 git+/#sha 的裸键
  printf '%s\n' "$PROBE_OUT" \
      | grep -oE "${PKG_NAME}@[^[:space:]\"']*" | head -1
}
WANT_KEY="$(extract_want_key)"

ensure_workspace_file() {
  mkdir -p "$(dirname "$WORKSPACE_YAML")"
  [ -f "$WORKSPACE_YAML" ] || printf 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n' > "$WORKSPACE_YAML"
}

append_key() {
  local key="$1"
  if grep -qF "$key" "$WORKSPACE_YAML" 2>/dev/null; then
    echo "==> allowBuilds 已包含该键，跳过"
    return 0
  fi
  if grep -qE '^allowBuilds:' "$WORKSPACE_YAML" 2>/dev/null; then
    printf '  %s: true\n' "$key" >> "$WORKSPACE_YAML"
  else
    printf '\nallowBuilds:\n  %s: true\n' "$key" >> "$WORKSPACE_YAML"
  fi
  echo "==> 已写入 allowBuilds 键：$key"
}

case "$PROBE_OUT" in
  *ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED*)
    # pnpm 11.x：git 托管包必须用完整键（含 #commit）；纯包名键永远匹配不上。
    if [ -z "$WANT_KEY" ]; then
      echo "⚠️ 未能从报错中提取精确键，回退到 dangerouslyAllowAllBuilds（会放行该 profile 所有依赖的构建脚本）"
      ensure_workspace_file
      grep -qE '^dangerouslyAllowAllBuilds:' "$WORKSPACE_YAML" 2>/dev/null \
        || printf '\ndangerouslyAllowAllBuilds: true\n' >> "$WORKSPACE_YAML"
    else
      ensure_workspace_file
      append_key "$WANT_KEY"
      echo "    注意：pnpm 11 的键带 commit，将来升级到新 commit 后需按新报错替换此键。"
    fi
    ;;
  *ERR_PNPM_INVALID_VERSION_UNION*)
    # pnpm 10.x：只认纯包名键，带 URL 反而报 "Use exact versions only."
    ensure_workspace_file
    append_key "$PKG_NAME"
    ;;
  *)
    echo "⚠️ 未识别的失败原因（exit=$PROBE_RC）。"
    echo "   若为构建脚本被拦截，可手动在 $WORKSPACE_YAML 加入："
    echo "     allowBuilds:"
    echo "       $PKG_NAME: true"
    echo "   或（两代通用、权限更宽）：dangerouslyAllowAllBuilds: true"
    exit 1
    ;;
esac

# ───────────────────────────────────────────────────────────────
# 第 2 次安装：放行后应成功
# ───────────────────────────────────────────────────────────────
echo "==> 第 2 次安装 ..."
if CI=true dsh plugin --profile "$PROFILE" add "$SELF_REPO"; then
  echo "✅ 安装完成。"
  echo "   升级：重新运行本脚本，或 dsh plugin --profile $PROFILE add '$SELF_REPO'"
else
  echo "❌ 安装仍然失败。请把上面的完整输出反馈给作者。"
  echo "   当前 $WORKSPACE_YAML 内容："
  sed 's/^/    | /' "$WORKSPACE_YAML" 2>/dev/null
  exit 1
fi
