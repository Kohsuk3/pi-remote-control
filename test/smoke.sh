#!/bin/bash
# Smoke test with a throwaway HOME and a fake tailscale so the real serve config is untouched.
set -u
cd "$(dirname "$0")"
T=$(mktemp -d); export HOME=$T
mkdir -p $T/bin $T/.pi/remote-control
cat > $T/bin/tailscale <<'TS'
#!/bin/bash
echo "$@" >> "$HOME/ts.log"
case "$1" in
  status) echo '{"Self":{"DNSName":"fake.ts.net."}}';;
  ip) echo 100.1.1.1;;
esac
TS
chmod +x $T/bin/tailscale
export PATH=$T/bin:$PATH
export JITI_PATH=$(ls -d /Users/saito-kosuke/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti)
unset HERDR_ENV
node child.mjs > $T/a.log 2>&1 & A=$!
sleep 3
node child.mjs > $T/b.log 2>&1 & B=$!
sleep 3
REG=$T/.pi/remote-control/sessions.json
PORTS=($(python3 -c "import json;print(*[e['port'] for e in json.load(open('$REG'))])"))
PA_PORT=${PORTS[0]}; PB_PORT=${PORTS[1]}
fail=0; ok(){ echo "PASS $1"; }; ng(){ echo "FAIL $1"; fail=1; }
PA=$(python3 -c "import json;print(json.load(open('$T/.pi/remote-control/hub.json'))['port'])")
[ "$PA" = "$PA_PORT" ] && ok "A owns hub" || ng "A owns hub ($PA)"
SESS=$(curl -s localhost:$PA_PORT/sessions)
[ "$(echo $SESS | python3 -c 'import sys,json;print(len(json.load(sys.stdin)["sessions"]))')" = 2 ] && ok "2 sessions listed" || ng "sessions: $SESS"
BID=$(echo $SESS | PBP=$PB_PORT python3 -c "import sys,json,os;print([x['sessionId'] for x in json.load(sys.stdin)['sessions'] if x['port']==int(os.environ['PBP'])][0])")
[ -n "$BID" ] && [ "$(curl -s localhost:$PA_PORT/s/$BID/poll | python3 -c 'import sys,json;print(json.load(sys.stdin)["sessionId"])')" = "$BID" ] && ok "proxy A->B poll" || ng "proxy"
[ "$(curl -s -o /dev/null -w %{http_code} localhost:$PA_PORT/s/deadbeef/poll)" = 404 ] && ok "proxy unknown -> 404" || ng "404"
curl -s -XPOST localhost:$PB_PORT/interrupt >/dev/null; sleep 0.3
grep -q ABORTED $T/b.log && ok "interrupt aborts agent" || ng "interrupt"
curl -s localhost:$PA_PORT/ | python3 -c "
import sys,re;h=sys.stdin.read();m=re.search(r'<script>(.*)</script>',h,re.S);open('$T/client.js','w').write(m.group(1))"
node --check $T/client.js && ok "client JS parses" || ng "client JS"
kill $A; sleep 7
PB=$(python3 -c "import json;print(json.load(open('$T/.pi/remote-control/hub.json'))['port'])")
[ "$PB" = "$PB_PORT" ] && ok "B takes over hub" || ng "takeover ($PB)"
kill $B; sleep 1
grep -q " off" $T/ts.log && ok "serve removed when last session exits" || ng "teardown"
kill $A $B 2>/dev/null
exit $fail
