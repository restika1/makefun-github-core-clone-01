#!/usr/bin/env bash
# REST v3 surface test against the running forge (port from $PORT, token $TOK).
set -u
BASE="http://127.0.0.1:${PORT:?}"
TOK="${TOK:?}"
A="Authorization: Bearer $TOK"
CT="Content-Type: application/json"
pass=0; fail=0

ck() { # ck <label> <expected> <actual>
  if [ "$2" = "$3" ]; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL $1: expected $2 got $3"; fi
}

# root + meta
ck "root" 200 "$(curl -s -o /dev/null -w '%{http_code}' -H "$A" $BASE/api/v3/)"
ck "root scopes hdr" "repo, read:org" "$(curl -s -D- -o /dev/null -H "$A" $BASE/api/v3/ | tr -d '\r' | grep -i '^x-oauth-scopes:' | cut -d' ' -f2-)"
ck "root req-id hdr" "yes" "$(curl -s -D- -o /dev/null -H "$A" $BASE/api/v3/ | tr -d '\r' | grep -qi '^x-github-request-id: .' && echo yes)"
ck "meta" 200 "$(curl -s -o /dev/null -w '%{http_code}' -H "$A" $BASE/api/v3/meta)"
ck "meta version" "yes" "$(curl -s -H "$A" $BASE/api/v3/meta | grep -q '"installed_version"' && echo yes)"

# auth
ck "no token 401" 401 "$(curl -s -o /dev/null -w '%{http_code}' $BASE/api/v3/repos/adaiversen/x)"
ck "bad token 401" 401 "$(curl -s -o /dev/null -w '%{http_code}' -H 'Authorization: Bearer wrong' $BASE/api/v3/repos/adaiversen/x)"

# create repos
for i in $(seq 1 12); do
  curl -s -o /dev/null -H "$A" -H "$CT" -X POST -d "{\"name\":\"pagination-repo-$i\",\"private\":true}" $BASE/api/v3/user/repos
done
ck "create 201" 201 "$(curl -s -o /dev/null -w '%{http_code}' -H "$A" -H "$CT" -X POST -d '{"name":"r-create","private":true,"description":"d"}' $BASE/api/v3/user/repos)"
ck "create private" '"private":true' "$(curl -s -H "$A" $BASE/api/v3/repos/adaiversen/r-create | grep -o '"private":true')"
ck "create dup 422" 422 "$(curl -s -o /dev/null -w '%{http_code}' -H "$A" -H "$CT" -X POST -d '{"name":"r-create"}' $BASE/api/v3/user/repos)"
ck "get repo 200" 200 "$(curl -s -o /dev/null -w '%{http_code}' -H "$A" $BASE/api/v3/repos/adaiversen/r-create)"
ck "get missing 404" 404 "$(curl -s -o /dev/null -w '%{http_code}' -H "$A" $BASE/api/v3/repos/adaiversen/r-never-created)"
ck "foreign owner 404" 404 "$(curl -s -o /dev/null -w '%{http_code}' -H "$A" $BASE/api/v3/repos/olgabauer/r-create)"
ck "patch 200" 200 "$(curl -s -o /dev/null -w '%{http_code}' -H "$A" -H "$CT" -X PATCH -d '{"description":"updated"}' $BASE/api/v3/repos/adaiversen/r-create)"
ck "patch desc" updated "$(curl -s -H "$A" $BASE/api/v3/repos/adaiversen/r-create | grep -o '"description":"updated"' | cut -d'"' -f4)"

# pagination: 12 repos at per_page=5 -> 3 pages via Link
n=0; url="$BASE/api/v3/user/repos?per_page=5"
while [ -n "$url" ] && [ "$url" != "null" ] && [ $n -lt 10 ]; do
  resp=$(curl -s -D /tmp/opencode/h.txt -H "$A" "$url")
  count=$(echo "$resp" | grep -o '"name":"' | wc -l)
  [ "$count" -le 5 ] || { fail=$((fail+1)); echo "FAIL page size $count > 5"; }
  n=$((n+1))
  url=$(tr -d '\r' < /tmp/opencode/h.txt | grep -i '^link:' | grep -o '<[^>]*>; rel="next"' | sed 's/<\(.*\)>; rel="next"/\1/')
done
ck "pagination pages" "yes" "$([ $n -ge 3 ] && echo yes)"

# contents
C1=$(printf 'hello world' | base64 -w0)
C2=$(printf 'hello forge!' | base64 -w0)
curl -s -o /dev/null -H "$A" -H "$CT" -X POST -d '{"name":"r-contents","private":true}' $BASE/api/v3/user/repos
URL="$BASE/api/v3/repos/adaiversen/r-contents/contents/src/readme.md"
ck "contents create 201" 201 "$(curl -s -o /dev/null -w '%{http_code}' -H "$A" -H "$CT" -X PUT -d "{\"message\":\"m\",\"content\":\"$C1\"}" $URL)"
SHA1=$(curl -s -H "$A" $URL | grep -o '"sha":"[0-9a-f]*"' | head -1 | cut -d'"' -f4)
ck "contents update 200" 200 "$(curl -s -o /dev/null -w '%{http_code}' -H "$A" -H "$CT" -X PUT -d "{\"message\":\"m\",\"content\":\"$C2\",\"sha\":\"$SHA1\"}" $URL)"
ck "contents stale 409" 409 "$(curl -s -o /dev/null -w '%{http_code}' -H "$A" -H "$CT" -X PUT -d "{\"message\":\"m\",\"content\":\"$C1\",\"sha\":\"$SHA1\"}" $URL)"
ck "contents get" "hello forge!" "$(curl -s -H "$A" $URL | grep -o '"content":"[^"]*"' | cut -d'"' -f4 | base64 -d)"
ck "contents dir" "yes" "$(curl -s -H "$A" $BASE/api/v3/repos/adaiversen/r-contents/contents/src | grep -q '"type":"file"' && echo yes)"
SHA2=$(curl -s -H "$A" $URL | grep -o '"sha":"[0-9a-f]*"' | head -1 | cut -d'"' -f4)
ck "contents delete 200" 200 "$(curl -s -o /dev/null -w '%{http_code}' -H "$A" -H "$CT" -X DELETE -d "{\"message\":\"m\",\"sha\":\"$SHA2\"}" $URL)"
ck "contents gone 404" 404 "$(curl -s -o /dev/null -w '%{http_code}' -H "$A" $URL)"

# branches + commits (pull prerequisites)
curl -s -o /dev/null -H "$A" -H "$CT" -X POST -d '{"name":"r-git","private":true}' $BASE/api/v3/user/repos
C3=$(printf 'base file' | base64 -w0)
GURL="$BASE/api/v3/repos/adaiversen/r-git"
ck "unborn contents 201" 201 "$(curl -s -o /dev/null -w '%{http_code}' -H "$A" -H "$CT" -X PUT -d "{\"message\":\"init\",\"content\":\"$C3\"}" $GURL/contents/base.txt)"
TIP=$(curl -s -H "$A" $GURL/branches | grep -o '"sha":"[0-9a-f]*"' | head -1 | cut -d'"' -f4)
ck "branch 201" 201 "$(curl -s -o /dev/null -w '%{http_code}' -H "$A" -H "$CT" -X POST -d "{\"ref\":\"refs/heads/feature-x\",\"sha\":\"$TIP\"}" $GURL/git/refs)"
ck "branch list" "yes" "$(curl -s -H "$A" $GURL/branches | grep -q '"name":"feature-x"' && echo yes)"
C4=$(printf 'feature file' | base64 -w0)
ck "branch commit 201" 201 "$(curl -s -o /dev/null -w '%{http_code}' -H "$A" -H "$CT" -X PUT -d "{\"message\":\"feat\",\"content\":\"$C4\",\"branch\":\"feature-x\"}" $GURL/contents/feat.txt)"
ck "commits branch has feat" "yes" "$(curl -s -H "$A" "$GURL/commits?sha=feature-x" | grep -q '"message":"feat"' && echo yes)"
ck "commits default lacks feat" "yes" "$(curl -s -H "$A" "$GURL/commits" | grep -q '"message":"feat"' || echo yes)"

# pulls
ck "pull 201" 201 "$(curl -s -o /dev/null -w '%{http_code}' -H "$A" -H "$CT" -X POST -d '{"title":"pr1","body":"pb","head":"feature-x","base":"main"}' $GURL/pulls)"
PNUM=$(curl -s -H "$A" "$GURL/pulls?state=open" | grep -o '"number":[0-9]*' | head -1 | cut -d: -f2)
ck "pull get 200" 200 "$(curl -s -o /dev/null -w '%{http_code}' -H "$A" $GURL/pulls/$PNUM)"
ck "pull get 404" 404 "$(curl -s -o /dev/null -w '%{http_code}' -H "$A" $GURL/pulls/99999)"
ck "pull files added" "yes" "$(curl -s -H "$A" $GURL/pulls/$PNUM/files | grep -q '"filename":"feat.txt"' && echo yes)"
ck "merge 200" 200 "$(curl -s -o /dev/null -w '%{http_code}' -H "$A" -H "$CT" -X PUT -d '{"merge_method":"squash"}' $GURL/pulls/$PNUM/merge)"
ck "merge unknown 404" 404 "$(curl -s -o /dev/null -w '%{http_code}' -H "$A" -H "$CT" -X PUT -d '{}' $GURL/pulls/99999/merge)"
ck "merged closed" "yes" "$(curl -s -H "$A" $GURL/pulls/$PNUM | grep -q '"state":"closed"' && curl -s -H "$A" $GURL/pulls/$PNUM | grep -q '"merged":true' && echo yes)"
ck "merged content on base" "feature file" "$(curl -s -H "$A" "$GURL/contents/feat.txt?ref=main" | grep -o '"content":"[^"]*"' | cut -d'"' -f4 | base64 -d)"
MERGESHA=$(curl -s -H "$A" $GURL/pulls/$PNUM | grep -o '"merge_commit_sha":"[0-9a-f]*"' | cut -d'"' -f4)
ck "merge commit listed" "yes" "$(curl -s -H "$A" "$GURL/commits?sha=main" | grep -q "\"sha\":\"$MERGESHA\"" && echo yes)"

# labels + issues
curl -s -o /dev/null -H "$A" -H "$CT" -X POST -d '{"name":"r-issues","private":true}' $BASE/api/v3/user/repos
ck "label 201" 201 "$(curl -s -o /dev/null -w '%{http_code}' -H "$A" -H "$CT" -X POST -d '{"name":"bug","color":"ededed"}' $BASE/api/v3/repos/adaiversen/r-issues/labels)"
ck "issue 201" 201 "$(curl -s -o /dev/null -w '%{http_code}' -H "$A" -H "$CT" -X POST -d '{"title":"t1","body":"b1","labels":["bug"]}' $BASE/api/v3/repos/adaiversen/r-issues/issues)"
ck "issue bad label 422" 422 "$(curl -s -o /dev/null -w '%{http_code}' -H "$A" -H "$CT" -X POST -d '{"title":"t2","body":"b","labels":["nope"]}' $BASE/api/v3/repos/adaiversen/r-issues/issues)"
N1=$(curl -s -H "$A" -H "$CT" -X POST -d '{"title":"t3","body":"b"}' $BASE/api/v3/repos/adaiversen/r-issues/issues | grep -o '"number":[0-9]*' | head -1 | cut -d: -f2)
N2=$(curl -s -H "$A" -H "$CT" -X POST -d '{"title":"t4","body":"b"}' $BASE/api/v3/repos/adaiversen/r-issues/issues | grep -o '"number":[0-9]*' | head -1 | cut -d: -f2)
ck "issue numbers +1" "yes" "$([ "$N2" -eq $((N1+1)) ] && echo yes)"
ck "issue get 200" 200 "$(curl -s -o /dev/null -w '%{http_code}' -H "$A" $BASE/api/v3/repos/adaiversen/r-issues/issues/$N1)"
ck "issue get 404" 404 "$(curl -s -o /dev/null -w '%{http_code}' -H "$A" $BASE/api/v3/repos/adaiversen/r-issues/issues/99999)"
ck "issue close 200" 200 "$(curl -s -o /dev/null -w '%{http_code}' -H "$A" -H "$CT" -X PATCH -d '{"state":"closed"}' $BASE/api/v3/repos/adaiversen/r-issues/issues/$N2)"
ck "open list omits closed" "yes" "$(curl -s -H "$A" "$BASE/api/v3/repos/adaiversen/r-issues/issues?state=open&per_page=100" | grep -q "\"number\":$N2" || echo yes)"
ck "open list has open" "yes" "$(curl -s -H "$A" "$BASE/api/v3/repos/adaiversen/r-issues/issues?state=open&per_page=100" | grep -q "\"number\":$N1" && echo yes)"
ck "comment 201" 201 "$(curl -s -o /dev/null -w '%{http_code}' -H "$A" -H "$CT" -X POST -d '{"body":"c1"}' $BASE/api/v3/repos/adaiversen/r-issues/issues/$N1/comments)"
ck "comments list" "yes" "$(curl -s -H "$A" $BASE/api/v3/repos/adaiversen/r-issues/issues/$N1/comments | grep -q '"body":"c1"' && echo yes)"

# protocol
ck "malformed 400" 400 "$(curl -s -o /dev/null -w '%{http_code}' -H "$A" -H "$CT" -X POST -d '{"name":' $BASE/api/v3/user/repos)"
ck "unknown route 404" 404 "$(curl -s -o /dev/null -w '%{http_code}' -H "$A" $BASE/api/v3/no-such-route)"
ck "404 not html" "yes" "$(curl -s -H "$A" $BASE/api/v3/no-such-route | grep -q '"message"' && echo yes)"
ck "delete repo 204" 204 "$(curl -s -o /dev/null -w '%{http_code}' -H "$A" -X DELETE $BASE/api/v3/repos/adaiversen/r-contents)"
ck "deleted repo 404" 404 "$(curl -s -o /dev/null -w '%{http_code}' -H "$A" $BASE/api/v3/repos/adaiversen/r-contents)"

echo "REST: $pass passed, $fail failed"
exit $fail
