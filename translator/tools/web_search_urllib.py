#!/usr/bin/env python3
import argparse
import html
import json
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))
import ddg_urllib_search


USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"
BLOCKED_DOMAINS = ("reuters.com", "wsj.com", "nytimes.com", "zhihu.com")


def normalize_space(value):
    return re.sub(r"\s+", " ", value or "").strip()


def html_to_text(value):
    value = re.sub(r"<script\b[^>]*>[\s\S]*?</script>", " ", value or "", flags=re.I)
    value = re.sub(r"<style\b[^>]*>[\s\S]*?</style>", " ", value, flags=re.I)
    value = re.sub(r"</(h[1-6]|p|li|tr|div|section|article|br)>", "\n", value, flags=re.I)
    value = re.sub(r"<[^>]+>", " ", value)
    return normalize_space(html.unescape(value))


def decode_body(raw, headers):
    candidates = []
    content_type = headers.get("content-type", "")
    match = re.search(r"charset=([^;\s]+)", content_type, re.I)
    if match:
        candidates.append(match.group(1))
    head = raw[:4096].decode("ascii", errors="ignore")
    match = re.search(r"<meta[^>]+charset=['\"]?([^'\"\s/>]+)", head, re.I)
    if match:
        candidates.append(match.group(1))
    candidates.extend(["utf-8", "gb18030", "big5", "latin-1"])
    for charset in candidates:
        try:
            return raw.decode(charset, errors="replace")
        except LookupError:
            continue
    return raw.decode("utf-8", errors="replace")


def page_title(text):
    match = re.search(r"<title[^>]*>(.*?)</title>", text or "", re.I | re.S)
    return normalize_space(html.unescape(re.sub(r"<[^>]+>", " ", match.group(1)))) if match else ""


def fetch_page(url, max_chars):
    host = urllib.parse.urlparse(url).netloc.lower()
    if any(domain in host for domain in BLOCKED_DOMAINS):
        return {"fetched": False, "snippet_only": True, "fetch_error": "blocked_domain"}
    try:
        req = urllib.request.Request(
            url,
            headers={
                "User-Agent": USER_AGENT,
                "Accept": "text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.8",
                "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
            },
        )
        with urllib.request.urlopen(req, timeout=15) as resp:
            raw = resp.read(1_000_000)
            content_type = resp.headers.get("content-type", "")
            decoded = decode_body(raw, resp.headers)
            text = html_to_text(decoded) if "html" in content_type or "<html" in decoded[:1000].lower() else normalize_space(decoded)
            return {
                "fetched": True,
                "snippet_only": False,
                "status": resp.status,
                "content_type": content_type,
                "page_title": page_title(decoded),
                "excerpt": text[:max_chars],
            }
    except urllib.error.HTTPError as exc:
        return {"fetched": False, "snippet_only": True, "fetch_error": f"HTTP {exc.code}"}
    except Exception as exc:
        return {"fetched": False, "snippet_only": True, "fetch_error": str(exc)[:300]}


def weak_relevance(query, result):
    terms = [t.lower() for t in re.findall(r"[\w\u4e00-\u9fff]+", query) if len(t) >= 2]
    haystack = f"{result.get('title', '')} {result.get('snippet', '')}".lower()
    if not terms:
        return False
    hits = sum(1 for term in terms if term in haystack)
    return hits == 0 or (len(terms) >= 3 and hits < 2)


def extract_date(value):
    patterns = [
        r"\b20\d{2}[-/.年]\d{1,2}[-/.月]\d{1,2}日?\b",
        r"\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s+20\d{2}\b",
        r"\b20\d{2}\b",
    ]
    for pattern in patterns:
        match = re.search(pattern, value or "", re.I)
        if match:
            return match.group(0)
    return ""


def run(query, count, fetch_top, excerpt_chars):
    base = ddg_urllib_search.search(query, count)
    results = base.get("results", [])
    for index, result in enumerate(results):
        result["source"] = urllib.parse.urlparse(result.get("url", "")).netloc
        result["weak_relevance"] = weak_relevance(query, result)
        result["date"] = extract_date(f"{result.get('title', '')} {result.get('snippet', '')}")
        if index < fetch_top:
            fetched = fetch_page(result.get("url", ""), excerpt_chars)
            result.update(fetched)
            if not result.get("date"):
                result["date"] = extract_date(f"{result.get('page_title', '')} {result.get('excerpt', '')}")
        else:
            result["fetched"] = False
            result["snippet_only"] = True
    return {
        "ok": bool(base.get("ok")),
        "query": query,
        "generated_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "engine": base.get("engine"),
        "attempts": base.get("attempts", []),
        "results": results,
    }


def main():
    parser = argparse.ArgumentParser(description="Worker-style no-key web search via Python urllib and DuckDuckGo Lite/HTML.")
    parser.add_argument("query")
    parser.add_argument("legacy_count", nargs="?", type=int)
    parser.add_argument("-n", "--count", type=int, default=None)
    parser.add_argument("--fetch-top", type=int, default=0)
    parser.add_argument("--excerpt-chars", type=int, default=2500)
    args = parser.parse_args()

    count = args.count if args.count is not None else args.legacy_count
    count = max(1, min(count or 5, 10))
    fetch_top = max(0, min(args.fetch_top, count))
    print(json.dumps(run(args.query, count, fetch_top, args.excerpt_chars), ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
