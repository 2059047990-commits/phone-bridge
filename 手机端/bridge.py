# phone-bridge.py  —  让 RikkaHub 里的助手在 Termux 上执行命令
# 只监听 127.0.0.1，局域网里其他设备访问不到
# 令牌从环境变量读：export PHONE_BRIDGE_TOKEN='随便一串随机字符'
import http.server, subprocess, json, hmac, os

TOKEN = os.environ.get("PHONE_BRIDGE_TOKEN", "")
if not TOKEN:
    raise SystemExit("缺少环境变量 PHONE_BRIDGE_TOKEN")
HOST, PORT, LIMIT = "127.0.0.1", 8787, 300000

class H(http.server.BaseHTTPRequestHandler):
    def j(self, c, o):
        b = json.dumps(o, ensure_ascii=False).encode()
        self.send_response(c)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def ok(self):
        return hmac.compare_digest(self.headers.get("X-Token", ""), TOKEN)

    def do_GET(self):
        if not self.ok():
            return self.j(401, {"error": "unauthorized"})
        self.j(200, {"ok": 1, "home": os.path.expanduser("~"),
                     "storage": os.path.isdir(os.path.expanduser("~/storage"))})

    def do_POST(self):
        if not self.ok():
            return self.j(401, {"error": "unauthorized"})
        n = int(self.headers.get("Content-Length") or 0)
        try:
            req = json.loads(self.rfile.read(n) or b"{}")
        except Exception:
            return self.j(400, {"error": "bad json"})
        cmd = (req.get("cmd") or "").strip()
        if not cmd:
            return self.j(400, {"error": "empty cmd"})
        try:
            p = subprocess.run(["bash", "-lc", cmd], cwd=req.get("cwd") or os.path.expanduser("~"),
                               capture_output=True, text=True, timeout=req.get("timeout") or 180)
            self.j(200, {"code": p.returncode, "stdout": p.stdout[-LIMIT:], "stderr": p.stderr[-LIMIT:]})
        except subprocess.TimeoutExpired:
            self.j(200, {"code": 124, "stdout": "", "stderr": "timeout"})

    def log_message(self, *a):
        pass

if __name__ == "__main__":
    print("[bridge] up on http://%s:%d  (Ctrl+C to stop)" % (HOST, PORT), flush=True)
    http.server.ThreadingHTTPServer((HOST, PORT), H).serve_forever()
