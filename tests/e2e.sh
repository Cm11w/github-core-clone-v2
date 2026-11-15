#!/bin/bash
# End-to-end battery for forge-v2 with the REAL git CLI + curl.
# Starts its own fresh server, runs the checks, kills the server.
# Usage: tests/e2e.sh
set -u
cd "$(dirname "$0")/.."

PORT="${E2E_PORT:-18743}"
TOKEN="e2e-token-9"
BASE="http://127.0.0.1:$PORT"
AUTH="Authorization: Bearer $TOKEN"
WORK="$(mktemp -d /tmp/forge-v2-e2e.XXXXXX)"
PASS=0
FAIL=0
FAILED_CHECKS=()

# Git reads auth + identity from the environment, so plain `git` works
# everywhere, including inside `bash -c` strings.
export GIT_CONFIG_COUNT=3
export GIT_CONFIG_KEY_0=http.extraHeader GIT_CONFIG_VALUE_0="$AUTH"
export GIT_CONFIG_KEY_1=user.email GIT_CONFIG_VALUE_1=e2e@example.invalid
export GIT_CONFIG_KEY_2=user.name GIT_CONFIG_VALUE_2=E2E
export GIT_TERMINAL_PROMPT=0

ok() { PASS=$((PASS + 1)); echo "PASS: $1"; }
bad() { FAIL=$((FAIL + 1)); FAILED_CHECKS+=("$1"); echo "FAIL: $1"; }
check() { # check <name> <command...>
  local name="$1"; shift
  if "$@" >/tmp/e2e-last.out 2>&1; then ok "$name"; else bad "$name"; sed 's/^/    /' /tmp/e2e-last.out | head -8; fi
}

# --- server ---------------------------------------------------------------
MAKEFUN_SHOP_TOKEN="$TOKEN" PORT=$PORT node --experimental-strip-types main.ts > "$WORK/server.log" 2>&1 &
SRVPID=$!
trap 'kill $SRVPID 2>/dev/null; rm -rf "$WORK"' EXIT
for _ in $(seq 1 40); do curl -sf "$BASE/healthz" >/dev/null 2>&1 && break; sleep 0.25; done
curl -sf "$BASE/healthz" >/dev/null 2>&1 || { echo "SERVER DID NOT START"; cat "$WORK/server.log"; exit 1; }

rest() { # rest <method> <path> [body]
  local method="$1" path="$2" body="${3:-}"
  if [ -n "$body" ]; then
    curl -sf -X "$method" -H "$AUTH" -H "Content-Type: application/json" -d "$body" "$BASE$path"
  else
    curl -sf -X "$method" -H "$AUTH" "$BASE$path"
  fi
}
export -f rest
export BASE AUTH

# --- 1. empty repo: REST create + real git clone ---------------------------
rest POST /api/v3/user/repos '{"name":"e2e-empty","private":false}' >/dev/null
check "clone empty repo" git clone "$BASE/adaiversen/e2e-empty.git" "$WORK/empty"
check "empty clone has no commits" bash -c "! git -C $WORK/empty rev-parse HEAD >/dev/null 2>&1"

# --- 2. real git push + clone-back byte-identical --------------------------
mkdir -p "$WORK/src" && cd "$WORK/src" && git init -q -b main .
printf 'hello\nworld\n' > a.txt && mkdir -p docs/deep && printf '# docs\n' > docs/deep/readme.md
git add -A && git commit -qm "first commit"
FIRST_SHA=$(git rev-parse HEAD)
check "push first commit (real git)" git push "$BASE/adaiversen/e2e-empty.git" main
cd "$WORK"
check "clone back" git clone "$BASE/adaiversen/e2e-empty.git" "$WORK/back"
check "clone-back HEAD matches" bash -c "[ \"\$(git -C $WORK/back rev-parse HEAD)\" = \"$FIRST_SHA\" ]"
check "clone-back files byte-identical" bash -c "cmp $WORK/src/a.txt $WORK/back/a.txt && cmp $WORK/src/docs/deep/readme.md $WORK/back/docs/deep/readme.md"
check "clone-back fsck clean" git -C "$WORK/back" fsck --strict

# --- 3. second push with deltas (git sends a thin delta pack) --------------
cd "$WORK/src"
printf 'hello\nworld\nthird line\n' > a.txt && git add -A && git commit -qm "second commit"
SECOND_SHA=$(git rev-parse HEAD)
check "push delta pack" git push "$BASE/adaiversen/e2e-empty.git" main
cd "$WORK"
check "fetch picks up second commit" bash -c "git -C $WORK/back fetch origin && [ \"\$(git -C $WORK/back rev-parse origin/main)\" = \"$SECOND_SHA\" ]"

# --- 4. annotated + lightweight tags, ls-remote -----------------------------
cd "$WORK/src"
git tag -a v1 -m "release one" && git tag light
check "push tags" git push "$BASE/adaiversen/e2e-empty.git" v1 light
cd "$WORK"
REMOTE=$(git ls-remote "$BASE/adaiversen/e2e-empty.git")
check "ls-remote lists annotated tag peeled" bash -c "echo '$REMOTE' | grep -qF 'refs/tags/v1^{}'"
check "ls-remote lists lightweight tag" bash -c "echo '$REMOTE' | grep -q 'refs/tags/light$'"

# --- 5. shallow clone + deepen (real git sends deepen-relative) ------------
check "shallow clone depth 1" git clone --depth 1 "$BASE/adaiversen/e2e-empty.git" "$WORK/shallow"
check "shallow clone has 1 commit" bash -c "[ \"\$(git -C $WORK/shallow rev-list --count HEAD)\" = 1 ]"
check "deepen by 1" bash -c "git -C $WORK/shallow fetch --deepen=1 origin main"
check "deepened clone has 2 commits" bash -c "[ \"\$(git -C $WORK/shallow rev-list --count origin/main)\" = 2 ]"

# --- 6. partial clone with filter ------------------------------------------
check "clone --filter=blob:none" git clone --filter=blob:none "$BASE/adaiversen/e2e-empty.git" "$WORK/filtered"
check "filtered clone resolves HEAD" bash -c "[ -n \"\$(git -C $WORK/filtered rev-parse HEAD)\" ]"

# --- 7. non-fast-forward rejected SERVER-side ------------------------------
cd "$WORK/src" && git checkout -qb tmpmove && printf 'moved\n' > b.txt && git add -A && git commit -qm "move main" && git checkout -q main && git merge -q --ff-only tmpmove
git push "$BASE/adaiversen/e2e-empty.git" main >/dev/null 2>&1
MAIN_AFTER=$(git rev-parse HEAD)
cd "$WORK"
git clone -q "$BASE/adaiversen/e2e-empty.git" "$WORK/stale" >/dev/null 2>&1
git -C "$WORK/stale" reset -q --hard "$SECOND_SHA"
printf 'stale\n' > "$WORK/stale/a.txt" && git -C "$WORK/stale" commit -qam "stale work"
# --force makes git SEND the non-fast-forward update, so the rejection must
# come from the server (its ng reason surfaces in git's error output).
if git -C "$WORK/stale" push --force origin main:main >/tmp/e2e-last.out 2>&1; then
  bad "non-FF push must be rejected"
else
  grep -q "non-fast-forward" /tmp/e2e-last.out && ok "non-FF push rejected by server" || bad "non-FF rejection reason"
fi
REMOTE_MAIN=$(git ls-remote "$BASE/adaiversen/e2e-empty.git" refs/heads/main | cut -f1)
check "ref unchanged after rejected push" bash -c "[ \"$REMOTE_MAIN\" = \"$MAIN_AFTER\" ]"

# --- 8. concurrent pushes: 4 branches + same-branch race -------------------
rest POST /api/v3/user/repos '{"name":"e2e-race","private":false}' >/dev/null
git clone -q "$BASE/adaiversen/e2e-race.git" "$WORK/race0" >/dev/null 2>&1
git -C "$WORK/race0" checkout -q --orphan main && printf 'base\n' > "$WORK/race0/base.txt" && git -C "$WORK/race0" add -A && git -C "$WORK/race0" commit -qm base
git -C "$WORK/race0" push -q origin main
PUSH_PIDS=()
for b in b1 b2 b3 b4; do
  cp -r "$WORK/race0" "$WORK/race-$b"
  git -C "$WORK/race-$b" checkout -qb "$b" && printf '%s\n' "$b" > "$WORK/race-$b/$b.txt" && git -C "$WORK/race-$b" add -A && git -C "$WORK/race-$b" commit -qm "$b"
  git -C "$WORK/race-$b" push -q origin "$b" & PUSH_PIDS+=($!)
done
# Wait ONLY for the pushes: a bare `wait` would also wait for the server.
wait "${PUSH_PIDS[@]}"
RACE_COUNT=$(git ls-remote "$BASE/adaiversen/e2e-race.git" | grep -c 'refs/heads/b')
check "4 concurrent branch pushes land" bash -c "[ \"$RACE_COUNT\" = 4 ]"
# Same-branch race: two clones push different commits to refs/heads/contended.
for side in left right; do
  cp -r "$WORK/race0" "$WORK/race-$side"
  git -C "$WORK/race-$side" checkout -qb contended && printf '%s\n' "$side" > "$WORK/race-$side/contended.txt" && git -C "$WORK/race-$side" add -A && git -C "$WORK/race-$side" commit -qm "$side"
done
git -C "$WORK/race-left" push origin contended >/tmp/e2e-left.out 2>&1 & LPID=$!
git -C "$WORK/race-right" push origin contended >/tmp/e2e-right.out 2>&1 & RPID=$!
wait $LPID; LEFT_RC=$?
wait $RPID; RIGHT_RC=$?
check "same-branch race has exactly one winner" bash -c "[ $(( (LEFT_RC == 0) + (RIGHT_RC == 0) )) = 1 ]"

# --- 9. merge commit via real git -------------------------------------------
git -C "$WORK/race0" checkout -qb feature && printf 'feature\n' > "$WORK/race0/feature.txt" && git -C "$WORK/race0" add -A && git -C "$WORK/race0" commit -qm feature
git -C "$WORK/race0" checkout -q main && printf 'mainline\n' > "$WORK/race0/mainline.txt" && git -C "$WORK/race0" add -A && git -C "$WORK/race0" commit -qm mainline
git -C "$WORK/race0" merge -q --no-ff feature -m "merge feature"
MERGE_SHA=$(git -C "$WORK/race0" rev-parse HEAD)
check "push merge commit" git -C "$WORK/race0" push origin main
check "merge commit has 2 parents after fetch" bash -c "git -C $WORK/race-b1 fetch -q origin && [ \"\$(git -C $WORK/race-b1 cat-file -p $MERGE_SHA | grep -c '^parent ')\" = 2 ]"

# --- 10. slashed branch + %2F contents --------------------------------------
rest POST /api/v3/user/repos '{"name":"e2e-slash","private":false}' >/dev/null
NESTED_B64=$(printf 'nested' | base64)
check "PUT contents with %2F path" bash -c "rest PUT /api/v3/repos/adaiversen/e2e-slash/contents/docs%2Freadme.txt '{\"message\":\"add\",\"content\":\"$NESTED_B64\"}' >/dev/null"
check "GET nested file back" bash -c "rest GET /api/v3/repos/adaiversen/e2e-slash/contents/docs/readme.txt | grep -q '\"name\":\"readme.txt\"'"
check "no illegal tree entry named docs/readme.txt" bash -c "git clone -q $BASE/adaiversen/e2e-slash.git $WORK/slashclone && [ -f $WORK/slashclone/docs/readme.txt ]"
X_B64=$(printf x | base64)
check "PUT contents on slashed branch" bash -c "rest PUT /api/v3/repos/adaiversen/e2e-slash/contents/x.txt '{\"message\":\"x\",\"branch\":\"feature/deep/name\",\"content\":\"$X_B64\"}' >/dev/null && rest GET /api/v3/repos/adaiversen/e2e-slash/branches/feature/deep/name | grep -q '\"name\":\"feature/deep/name\"'"

# --- 11. big push: 5 MiB blob byte-identical --------------------------------
rest POST /api/v3/user/repos '{"name":"e2e-big","private":false}' >/dev/null
mkdir -p "$WORK/big" && git -C "$WORK/big" init -q -b main .
head -c 5242880 /dev/urandom > "$WORK/big/blob.bin"
git -C "$WORK/big" add -A && git -C "$WORK/big" commit -qm "big blob"
check "push 5 MiB blob" git -C "$WORK/big" push "$BASE/adaiversen/e2e-big.git" main
check "clone back 5 MiB blob" git clone -q "$BASE/adaiversen/e2e-big.git" "$WORK/bigback"
check "5 MiB blob byte-identical" bash -c "cmp $WORK/big/blob.bin $WORK/bigback/blob.bin"

# --- 12. malformed input: server survives ------------------------------------
printf 'zzzznot-a-pkt-line' | curl -s -o /dev/null -w "%{http_code}" -X POST -H "$AUTH" --data-binary @- "$BASE/adaiversen/e2e-empty.git/git-upload-pack" | grep -q . && ok "malformed upload-pack answered" || bad "malformed upload-pack answered"
printf 'garbage' | curl -s -o /dev/null -X POST -H "$AUTH" --data-binary @- "$BASE/adaiversen/e2e-empty.git/git-receive-pack"
printf '0000' | curl -s -o /dev/null -X POST -H "$AUTH" --data-binary @- "$BASE/adaiversen/e2e-empty.git/git-receive-pack"
check "server alive after malformed input" curl -sf "$BASE/healthz"
check "clone intact after malformed input" git clone -q "$BASE/adaiversen/e2e-empty.git" "$WORK/aftermath"

# --- 13. REST issue/PR/merge flow --------------------------------------------
rest POST /api/v3/user/repos '{"name":"e2e-flow","private":false}' >/dev/null
rest POST /api/v3/repos/adaiversen/e2e-flow/labels '{"name":"bug","color":"ff0000"}' >/dev/null
V1_B64=$(printf 'v1' | base64)
rest PUT /api/v3/repos/adaiversen/e2e-flow/contents/f.txt "{\"message\":\"init\",\"content\":\"$V1_B64\"}" >/dev/null
ISSUE_JSON=$(rest POST /api/v3/repos/adaiversen/e2e-flow/issues '{"title":"broken","body":"fix me","labels":["bug"]}')
check "issue created with label" bash -c "echo '$ISSUE_JSON' | grep -q '\"number\":1'"
rest PATCH /api/v3/repos/adaiversen/e2e-flow/issues/1 '{"state":"closed"}' | grep -q '"state":"closed"' && ok "issue closed" || bad "issue closed"
MAIN_SHA=$(rest GET /api/v3/repos/adaiversen/e2e-flow/branches/main | python3 -c "import sys,json;print(json.load(sys.stdin)['commit']['sha'])")
rest POST /api/v3/repos/adaiversen/e2e-flow/git/refs "{\"ref\":\"refs/heads/fix\",\"sha\":\"$MAIN_SHA\"}" >/dev/null
FIX_BLOB_SHA=$(rest GET '/api/v3/repos/adaiversen/e2e-flow/contents/f.txt?ref=fix' | python3 -c "import sys,json;print(json.load(sys.stdin)['sha'])")
V2_B64=$(printf 'v2' | base64)
rest PUT /api/v3/repos/adaiversen/e2e-flow/contents/f.txt "{\"message\":\"fix\",\"branch\":\"fix\",\"content\":\"$V2_B64\",\"sha\":\"$FIX_BLOB_SHA\"}" >/dev/null
PR_JSON=$(rest POST /api/v3/repos/adaiversen/e2e-flow/pulls '{"title":"fix it","head":"fix","base":"main"}')
check "PR created" bash -c "echo '$PR_JSON' | grep -q '\"number\":2'"
rest PUT /api/v3/repos/adaiversen/e2e-flow/pulls/2/merge '{"merge_method":"squash"}' | grep -q '"merged":true' && ok "PR squash-merged" || bad "PR squash-merged"
check "merged content on main" bash -c "rest GET /api/v3/repos/adaiversen/e2e-flow/contents/f.txt | grep -q '\"content\":\"$V2_B64\"'"

# --- 14. GraphQL invalid field + batch ---------------------------------------
GQL_BAD=$(curl -s -X POST -H "$AUTH" -d '{"query":"{ viewer { login noSuchFieldOnViewer } }"}' "$BASE/api/graphql")
check "GraphQL invalid field names the field" bash -c "echo '$GQL_BAD' | grep -q noSuchFieldOnViewer"
GQL_BATCH=$(curl -s -X POST -H "$AUTH" -d '[{"query":"{ viewer { login } }"},{"query":"{ viewer { login } }"}]' "$BASE/api/graphql")
check "GraphQL batch answers two in order" bash -c "[ \"\$(echo '$GQL_BATCH' | grep -o adaiversen | wc -l)\" = 2 ]"

# --- 15. MCP tools/list + tools/call ------------------------------------------
MCP_LIST=$(curl -s -X POST -H "$AUTH" -d '{"jsonrpc":"2.0","id":"a","method":"tools/list","params":{}}' "$BASE/mcp")
check "MCP tools/list has 10 tools" bash -c "echo '$MCP_LIST' | python3 -c \"import sys,json; d=json.load(sys.stdin); assert len(d['result']['tools'])==10\""
MCP_CALL=$(curl -s -X POST -H "$AUTH" -d '{"jsonrpc":"2.0","id":"b","method":"tools/call","params":{"name":"create_issue","arguments":{"owner":"adaiversen","repo":"e2e-flow","title":"via mcp"}}}' "$BASE/mcp")
check "MCP create_issue works" bash -c "echo '$MCP_CALL' | grep -q 'via mcp'"

echo
echo "e2e: $PASS passed, $FAIL failed"
if [ "$FAIL" -gt 0 ]; then echo "failed: ${FAILED_CHECKS[*]}"; exit 1; fi
