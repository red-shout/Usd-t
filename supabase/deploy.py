#!/usr/bin/env python3
"""Deploy Supabase Edge Functions from the repo (source of truth) and keep the pg_cron
pipeline pointed at the fresh function slug.

Run:  python3 supabase/deploy.py [slug ...]   (default: web ingest)
Secrets: SUPABASE_ACCESS_TOKEN (env) or /tmp/.sb_tok · project ref: supabase/project.ref or /tmp/ref
"""
import io, json, os, subprocess, sys, time, zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
REF = open(HERE + "/project.ref").read().strip() if os.path.exists(HERE + "/project.ref") else open("/tmp/ref").read().strip()
TOKEN = os.environ.get("SUPABASE_ACCESS_TOKEN") or open("/tmp/.sb_tok").read().strip()
API = f"https://api.supabase.com/v1/projects/{REF}"


def call(path, method="GET", data=None):
    cmd = ["curl", "-s", "--max-time", "40", "-X", method, API + path, "-H", "Authorization: Bearer " + TOKEN]
    if data is not None:
        cmd += ["-H", "Content-Type: application/json", "-d", json.dumps(data)]
    out = subprocess.run(cmd, capture_output=True, text=True, timeout=60).stdout
    try:
        return json.loads(out)
    except Exception:
        return {"raw": out}


def db(sql):
    return call("/database/query", "POST", {"query": sql})


def delete_old(slug):
    fn = call("/functions")
    for f in fn if isinstance(fn, list) else []:
        if f.get("name") == slug and f.get("status") != "REMOVED":
            call(f"/functions/{f['slug']}", "DELETE")

def deploy(slug, src_dir):
    delete_old(slug)
    zpath = f"/tmp/bundle_{slug}.zip"
    with open(zpath, "wb") as fb:
        with zipfile.ZipFile(fb, "w", zipfile.ZIP_DEFLATED) as z:
            for dirpath, _, files in os.walk(src_dir):
                for f in files:
                    full = os.path.join(dirpath, f)
                    z.write(full, os.path.relpath(full, src_dir))
    mpath = f"/tmp/meta_{slug}.json"
    open(mpath, "w").write(json.dumps({
        "function_slug": slug, "entrypoint_path": "index.ts",
        "name": slug, "verify_jwt": False, "use_api_esbuild": True,
    }))
    cmd = ["curl", "-s", "--max-time", "60", "-X", "POST", API + "/functions/deploy",
           "-H", "Authorization: Bearer " + TOKEN,
           "-F", f"metadata=<{mpath};type=application/json"]
    # the Management API wants ONE `file` part per source file
    for dirpath, _, files in os.walk(src_dir):
        for f in files:
            full = os.path.join(dirpath, f)
            rel = os.path.relpath(full, src_dir)
            cmd += ["-F", f"file=@{full};filename={rel};type=text/plain"]
    res = json.loads(subprocess.run(cmd, capture_output=True, text=True).stdout or "{}")
    did = res.get("id")
    if not did:
        return slug, "ERROR", res
    for _ in range(25):
        st = call(f"/functions/deploy/{did}")
        status = st.get("status")
        if status in ("ACTIVE", "REMOVED", "ERROR", "FAILED"):
            return slug, status, st.get("slug")
        time.sleep(2)
    return slug, "TIMEOUT", did


def rewire_cron():
    """Point the 30-min ingest cron at the ACTIVE ingest slug (re-derive, robust to poll flakiness)."""
    fn = call("/functions")
    slug = next((f["slug"] for f in (fn if isinstance(fn, list) else []) if f.get("name") == "ingest" and f.get("status") == "ACTIVE"), None)
    if not slug:
        print("cron: no active ingest found to point to"); return
    sql = ("select cron.alter_job(1, '*/30 * * * *', $q$ "
           "select net.http_post(url := 'https://" + REF + ".supabase.co/functions/v1/" + slug +
           "', body := '{}'::jsonb, headers := jsonb_build_object('Content-Type','application/json')); $q$)")
    db(sql)
    print(f"cron: jobid=1 -> {slug}")


if __name__ == "__main__":
    slugs = sys.argv[1:] or ["web", "ingest"]
    for s in slugs:
        name, status, info = deploy(s, os.path.join(HERE, "functions", s))
        print(f"{name:8s} -> {status} {str(info)[:120]}")
    if "ingest" in slugs:
        rewire_cron()
