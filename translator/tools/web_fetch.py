#!/usr/bin/env python3
"""Simple web fetch via urllib — extracts readable text from a URL."""
import urllib.request
import urllib.error
import re
import sys
import json

def html_to_text(raw):
    text = raw.decode("utf-8", errors="replace")
    text = re.sub(r'<script[^>]*>[\s\S]*?</script>', ' ', text, flags=re.IGNORECASE)
    text = re.sub(r'<style[^>]*>[\s\S]*?</style>', ' ', text, flags=re.IGNORECASE)
    text = re.sub(r'</(h[1-6]|p|li|tr|div|section|article|br)>', '\n', text, flags=re.IGNORECASE)
    text = re.sub(r'<[^>]+>', ' ', text)
    text = re.sub(r'&nbsp;', ' ', text)
    text = re.sub(r'&amp;', '&', text)
    text = re.sub(r'&lt;', '<', text)
    text = re.sub(r'&gt;', '>', text)
    text = re.sub(r'&quot;', '"', text)
    text = re.sub(r'&#39;', "'", text)
    text = re.sub(r'[ \t]+', ' ', text)
    text = re.sub(r'\n{3,}', '\n\n', text)
    text = text.strip()
    if len(text) > 20000:
        text = text[:20000] + f"\n\n[truncated {len(text)-20000} chars]"
    return text

def main():
    if len(sys.argv) < 2:
        print(json.dumps({"ok": False, "error": "URL required"}))
        sys.exit(1)

    url = sys.argv[1]
    try:
        req = urllib.request.Request(url, headers={
            "User-Agent": "Codex-Translator-WebFetch/0.1 (+local adapter)",
            "Accept": "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8",
        })
        resp = urllib.request.urlopen(req, timeout=15)
        raw = resp.read()
        text = html_to_text(raw)
        print(json.dumps({"ok": True, "url": url, "status": resp.status, "text": text}))
    except urllib.error.HTTPError as e:
        print(json.dumps({"ok": False, "url": url, "status": e.code, "error": str(e)}))
    except Exception as e:
        print(json.dumps({"ok": False, "url": url, "error": str(e)}))

if __name__ == "__main__":
    main()
