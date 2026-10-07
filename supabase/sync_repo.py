#!/usr/bin/env python3
"""Push the managed live-system files into red-shout/Usd-t (source of truth)."""
import base64, json, os, urllib.request

TOKEN = open("/tmp/.gh").read().strip()
REPO = "red-shout/Usd-t"
BR = "main"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # usd/
API = f"https://api.github.com/repos/{REPO}/contents/"

FILES = [
    ("supabase/functions/ingest/index.ts", "supabase/functions/ingest/index.ts"),
    ("supabase/functions/web/index.ts",     "supabase/functions/web/index.ts"),
    ("supabase/schema.sql",                 "supabase/schema.sql"),
    ("supabase/deploy.py",                  "supabase/deploy.py"),
    ("supabase/project.ref",                "supabase/project.ref"),
    ("supabase/sync_repo.py",               "supabase/sync_repo.py"),
    ("web/index.html",                       "ghdashboard/index.html"),
    ("LIVE.md",                              "LIVE.md"),
    ("README.md",                            "README.md"),
]

def get(url, raw=False):
    req = urllib.request.Request(url, headers={"Authorization": "Bearer " + TOKEN, "Accept": "application/vnd.github+json"})
    with urllib.request.urlopen(req) as r:
        b = r.read()
        return b.decode() if raw else json.loads(b)

for repo_path, local in FILES:
    full = os.path.join(ROOT, local)
    b64 = base64.b64encode(open(full, "rb").read()).decode()
    sha = ""
    try:
        sha = get(API + repo_path + "?ref=" + BR).get("sha", "")
    except Exception:
        sha = ""
    body = {"message": f"chore(live): sync {repo_path}", "content": b64, "branch": BR}
    if sha:
        body["sha"] = sha
    req = urllib.request.Request(API + repo_path, data=json.dumps(body).encode(),
                                 headers={"Authorization": "Bearer " + TOKEN, "Content-Type": "application/json"}, method="PUT")
    with urllib.request.urlopen(req) as r:
        d = json.load(r)
        print(f"{repo_path:34s} -> {d.get('content',{}).get('sha','?')[:8]}")
