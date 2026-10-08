#!/usr/bin/env python3
"""Push the managed live-system files into red-shout/Usd-t (source of truth)."""
import base64, json, os, urllib.request

TOKEN = open("/tmp/.gh").read().strip()
REPO = "red-shout/Usd-t"
BR = "main"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # usd/
API = f"https://api.github.com/repos/{REPO}/contents/"

# (repo_path, local_file, branch)  — web/index.html lives on the `live` branch (GitHub Pages data),
# everything else on `main` (code only).
FILES = [
    ("supabase/functions/ingest/index.ts", "supabase/functions/ingest/index.ts", "main"),
    ("supabase/functions/web/index.ts",     "supabase/functions/web/index.ts", "main"),
    ("supabase/schema.sql",                 "supabase/schema.sql", "main"),
    ("supabase/deploy.py",                  "supabase/deploy.py", "main"),
    ("supabase/project.ref",                "supabase/project.ref", "main"),
    ("supabase/sync_repo.py",               "supabase/sync_repo.py", "main"),
    ("LIVE.md",                              "LIVE.md", "main"),
    ("README.md",                            "README.md", "main"),
    ("index.html", "ghdashboard/index.html.tpl", "live"),
]

def get(url, raw=False):
    req = urllib.request.Request(url, headers={"Authorization": "Bearer " + TOKEN, "Accept": "application/vnd.github+json"})
    with urllib.request.urlopen(req) as r:
        b = r.read()
        return b.decode() if raw else json.loads(b)

for repo_path, local, branch in FILES:
    full = os.path.join(ROOT, local)
    raw = open(full, "rb").read()
    # SAFETY: never push an empty file — a bare PUT once blanked live:index.html.
    if not raw.strip():
        raise SystemExit(f"ABORT: {local} is empty - refusing to push a blank file")
    b64 = base64.b64encode(raw).decode()
    sha = ""
    try:
        sha = get(API + repo_path + "?ref=" + branch).get("sha", "")
    except Exception:
        sha = ""
    body = {"message": f"chore(live): sync {repo_path}", "content": b64, "branch": branch}
    if sha:
        body["sha"] = sha
    req = urllib.request.Request(API + repo_path, data=json.dumps(body).encode(),
                                 headers={"Authorization": "Bearer " + TOKEN, "Content-Type": "application/json"}, method="PUT")
    with urllib.request.urlopen(req) as r:
        d = json.load(r)
        print(f"{repo_path:34s} [{branch:5s}] -> {d.get('content',{}).get('sha','?')[:8]}")
