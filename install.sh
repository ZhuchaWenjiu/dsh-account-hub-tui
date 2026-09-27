#!/usr/bin/env bash
# dsh-account-hub-tui 一键安装脚本：为 dst（dsh-tui profile）装好
# dsh-account-hub（上游，需要 allowBuilds 构建白名单）与本桥接插件。
#
# 用法：
#   bash install.sh              # 安装到默认 profile dsh-tui
#   PROFILE=xxx bash install.sh  # 安装到指定 profile
set -euo pipefail

PROFILE="${PROFILE:-dsh-tui}"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
WORKSPACE_YAML="$DSH_HOME/profiles/$PROFILE/pnpm-workspace.yaml"
HUB_REPO="https://github.com/gurio-wine/dsh-account-hub.git"
HUB_ALLOW_BUILD_KEY="dsh-account-hub@git+https://github.com/gurio-wine/dsh-account-hub.git"

# 本插件仓库地址：优先从 git remote 推断（在克隆目录里运行时），否则用默认值。
SELF_REPO="${SELF_REPO:-}"
if [ -z "$SELF_REPO" ]; then
  SELF_REPO="$(git -C "$(cd "$(dirname "$0")" && pwd)" remote get-url origin 2>/dev/null || true)"
fi
SELF_REPO="${SELF_REPO:-https://github.com/gurio-wine/dsh-account-hub-tui.git}"

echo "==> dsh-account-hub-tui 安装器（profile: $PROFILE）"

for cmd in dsh pnpm; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "缺少 $cmd，请先安装（Node.js ≥ 20 + pnpm ≥ 10）"; exit 1; }
done

# ── 1) allowBuilds 白名单：hub 的 git 构建脚本需要放行 ──
# 安全插入：allowBuilds 键已存在 → 在其下补一行；不存在 → 追加新的顶层键。
# （不能盲目 append：落在列表/映射中间会产生非法 YAML。）
if [ -f "$WORKSPACE_YAML" ] && grep -qF "$HUB_ALLOW_BUILD_KEY" "$WORKSPACE_YAML"; then
  echo "==> allowBuilds 已包含 hub 白名单，跳过"
elif [ -f "$WORKSPACE_YAML" ] && grep -qE '^allowBuilds:' "$WORKSPACE_YAML"; then
  printf '  %s: true\n' "$HUB_ALLOW_BUILD_KEY" >> "$WORKSPACE_YAML"
  echo "==> 已在既有 allowBuilds 下追加 hub 白名单"
else
  printf '\nallowBuilds:\n  %s: true\n' "$HUB_ALLOW_BUILD_KEY" >> "$WORKSPACE_YAML"
  echo "==> 已追加 allowBuilds 配置块"
fi

# ── 2) 安装上游 hub（提供账号池/登录/模型路由）──
echo "==> 安装 dsh-account-hub ..."
CI=true dsh plugin --profile "$PROFILE" add "$HUB_REPO"

# ── 3) 安装本桥接插件 ──
echo "==> 安装 dsh-account-hub-tui ..."
CI=true dsh plugin --profile "$PROFILE" add "$SELF_REPO"

# ── 4) 校验 ──
echo "==> 校验 profile 配置树 ..."
if dsh --profile "$PROFILE" --dump-config 2>/dev/null | grep -q "account-hub-tui"; then
  echo "✅ 安装完成。重启 dst 后运行 /account_hub 即可使用。"
else
  echo "⚠️ 未在配置树中找到 account-hub-tui，请把上面的报错信息反馈给作者。"
  exit 1
fi
