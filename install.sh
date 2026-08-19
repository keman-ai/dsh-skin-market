#!/usr/bin/env sh
#
# 把皮肤市场装进 dsh 的 web profile。
#
# 两件事：把这个目录作为依赖装进 profile，然后往 profile 的 cordis.patch.yml
# 里加一行把它挂上。第二步是关键 —— 那个文件被 dsh 持续监视，写完约一秒内
# 热重组，所以 dsh 开着也能装，装完刷新页面即可，不必重启。
#
# 刻意不走 `dsh plugin --profile web add`：那条命令写的是 package.json 里的
# dsh.profile.bundles，不在热监视范围内，装完必须重启。
set -eu

PROFILE="${DSH_HOME:-$HOME/.dsh}/profiles/web"
HERE=$(cd "$(dirname "$0")" && pwd)

if [ ! -d "$PROFILE" ]; then
  echo "找不到 web profile：$PROFILE" >&2
  echo "先跑一次 dsh（dsh --profile web）让它把 profile 建出来，再执行本脚本。" >&2
  exit 1
fi

if ! command -v pnpm >/dev/null 2>&1; then
  echo "pnpm 不在 PATH 上。dsh 的插件安装本身就是转发 pnpm，所以必须先装它。" >&2
  echo "试试：corepack enable pnpm" >&2
  exit 1
fi

if [ ! -f "$HERE/lib/index.js" ] || [ ! -f "$HERE/lib/client.js" ]; then
  echo "缺少构建产物 lib/。仓库里本应带着它们；" >&2
  echo "如果你是从源码改的，先跑 pnpm install && pnpm build。" >&2
  exit 1
fi

echo "→ 装进 $PROFILE"
# -w：profile 目录自带 pnpm-workspace.yaml，pnpm 会认定它是 workspace 根并
# 拒绝安装（ERR_PNPM_ADDING_TO_ROOT）；这个 flag 就是「我确实要装到根」。
pnpm -C "$PROFILE" add -w "$HERE"

PATCH="$PROFILE/cordis.patch.yml"
if [ -f "$PATCH" ] && grep -q "name: dsh-skin-market" "$PATCH"; then
  echo "→ 挂载行已存在，跳过"
else
  echo "→ 写入挂载行 $PATCH"
  # 文件末尾可能没有换行，先补一个再追加，免得和上一行粘住。
  [ -f "$PATCH" ] && [ -n "$(tail -c 1 "$PATCH")" ] && printf '\n' >> "$PATCH"
  cat >> "$PATCH" <<'YAML'
- insert:
    - id: skin-market
      name: dsh-skin-market
YAML
fi

echo
echo "装好了。刷新浏览器页面，打开「设置 → 皮肤市场」。"
echo "（dsh 不用重启）"
