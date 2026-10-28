#!/usr/bin/env bash
#
# Rebase this fork onto the latest upstream JUANWANG-BUAA/dsh-full-remote.
#
# The fork adds one capability on top of upstream: an owner-supplied access
# token (see `accessToken` in README → Configuration). Everything else tracks
# upstream, so the job after an upstream release is: replay that one change set
# onto the new base, prove it still builds, then publish the tarball.
#
# Usage:
#   bash scripts/sync-upstream.sh
#   DSH_GIT_PROXY=http://192.168.100.202:7890 bash scripts/sync-upstream.sh
#
# DSH_GIT_PROXY is injected per git command only; this script never writes a
# global git or shell configuration and never stores a credential.
#
# Exit codes: 0 synced (or already current), 1 stopped for manual resolution.

set -uo pipefail

REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$REPO" || { echo "!! cannot enter $REPO" >&2; exit 1; }

PROXY=${DSH_GIT_PROXY:-}
GIT=(git)
if [ -n "$PROXY" ]; then
  GIT=(git -c "http.proxy=$PROXY")
  echo "==> git 走代理 $PROXY（仅本次命令）"
fi

if ! git remote get-url upstream >/dev/null 2>&1; then
  echo "==> 未配置 upstream，正在添加"
  git remote add upstream https://github.com/JUANWANG-BUAA/dsh-full-remote.git || exit 1
fi

echo "==> 拉取上游"
if ! "${GIT[@]}" fetch upstream main; then
  echo "!! fetch 失败。本机直连 GitHub 不通时，用 DSH_GIT_PROXY 指定代理后重试：" >&2
  echo "   DSH_GIT_PROXY=http://HOST:PORT bash scripts/sync-upstream.sh" >&2
  exit 1
fi

if git merge-base --is-ancestor upstream/main HEAD; then
  echo "==> 已包含上游全部提交，无需同步"
  exit 0
fi

behind=$(git rev-list --count HEAD..upstream/main)
ahead=$(git rev-list --count upstream/main..HEAD)
echo "==> 上游领先 $behind 个提交，本 fork 领先 $ahead 个，开始 rebase"
git log --oneline "HEAD..upstream/main" | sed 's/^/    /'

if ! git rebase upstream/main; then
  cat >&2 <<'MSG'

!! rebase 停在冲突处。按文件处理（详见 README「与上游同步」的冲突表）：

   CHANGELOG.md                保留上游新条目，把本 fork 那节重新贴到最上面
   README.md / README.zh.md    保留上游内容，补回 accessToken 配置行与说明
   package.json                上游版本号 + -custom-token.N 后缀
   src/index.ts                保留上游结构，重插 configuredToken 判定与 setToken()
   src/config.ts               allowTokenRead 之后补 accessToken 字段
   src/persist.ts              保留 validateAccessToken 版本（上游 bug 已在此修掉）
   src/control-routes.ts       /rotate-token 之后补 /set-token 路由
   src/client/*                重插自定义令牌表单与 token.custom.* 文案
   tests/control.test.ts       保留 'short'（非法）与 'Owner-Tok-1'（合法）两个用例
   src/proxy.ts                本 fork 未改动，冲突了直接取上游版本（git checkout --theirs）

   解决完：git add <file> && git rebase --continue
   想放弃：git rebase --abort
   冲突太多时可改用 patch 重放（README「同步（冲突多时）」一节）
MSG
  exit 1
fi

echo "==> rebase 完成，安装依赖"
if ! pnpm install --prefer-offline; then
  echo "!! pnpm install 失败，当前提交尚未推送" >&2
  exit 1
fi

echo "==> 完整检查（lint + 类型 + 单测 + 客户端测试 + 构建）"
if ! pnpm run check:ci; then
  echo "!! 检查未通过，先修再推（当前提交尚未上传，可直接 git commit --amend）" >&2
  exit 1
fi

echo "==> 打包"
pnpm pack >/dev/null || exit 1
TARBALL=$(ls -1t ./*.tgz 2>/dev/null | head -1)
echo "    $TARBALL"

echo "==> 推送到 fork（rebase 重写了历史，故用 --force-with-lease）"
if ! "${GIT[@]}" push --force-with-lease origin HEAD:main; then
  echo "!! 推送失败：确认 origin 凭据可用，或先 git push 手动处理" >&2
  exit 1
fi

cat <<MSG

==> 完成。

安装（先卸旧包，插件 id 固定为 reverse-proxy，两个包同时存在会组合冲突）：
    dsh plugin --profile web remove dsh-full-remote
    dsh plugin --profile web add $REPO/$TARBALL
MSG
