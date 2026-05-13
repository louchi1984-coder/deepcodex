#!/usr/bin/env python3
import html
import json
import re
import sys
import urllib.parse
import urllib.request


USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"


def decode(value):
    return html.unescape(re.sub(r"<[^>]+>", " ", value or "")).strip()


def normalize_space(value):
    return re.sub(r"\s+", " ", value or "").strip()


def normalize_ddg_url(value):
    value = html.unescape(value or "")
    try:
        parsed = urllib.parse.urlparse(value)
        query = urllib.parse.parse_qs(parsed.query)
        if "uddg" in query and query["uddg"]:
            return urllib.parse.unquote(query["uddg"][0])
        if value.startswith("//"):
            return "https:" + value
        if value.startswith("/"):
            return urllib.parse.urljoin("https://duckduckgo.com", value)
        return value
    except Exception:
        return value


def is_ad_or_internal_result(title, url):
    lowered_title = (title or "").strip().lower()
    lowered_url = (url or "").lower()
    if "duckduckgo.com/y.js" in lowered_url:
        return True
    if lowered_title == "more info" and "duckduckgo.com/duckduckgo-help-pages/company/ads-" in lowered_url:
        return True
    return False


def request_text(url, data=None, timeout=15):
    headers = {
        "User-Agent": USER_AGENT,
        "Accept": "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    }
    req = urllib.request.Request(url, data=data, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read()
        charset = resp.headers.get_content_charset() or "utf-8"
        return raw.decode(charset, errors="replace"), resp.status


def is_challenge(text):
    value = (text or "").lower()
    return "unfortunately, bots use duckduckgo too" in value or "anomaly-modal" in value


def parse_lite(text, count):
    links = re.findall(
        r"<a[^>]*class=['\"]result-link['\"][^>]*href=['\"]([^'\"]+)['\"][^>]*>(.*?)</a>",
        text or "",
        re.I | re.S,
    )
    if not links:
        links = re.findall(
            r"<a[^>]*href=['\"]([^'\"]+)['\"][^>]*class=['\"]result-link['\"][^>]*>(.*?)</a>",
            text or "",
            re.I | re.S,
        )
    snippets = re.findall(
        r"<td[^>]*class=['\"]result-snippet['\"][^>]*>(.*?)</td>",
        text or "",
        re.I | re.S,
    )
    results = []
    seen = set()
    for idx, (url, title) in enumerate(links):
        real_url = normalize_ddg_url(url)
        clean_title = normalize_space(decode(title))
        if not real_url or real_url in seen or is_ad_or_internal_result(clean_title, real_url):
            continue
        seen.add(real_url)
        results.append(
            {
                "title": clean_title,
                "url": real_url,
                "snippet": normalize_space(decode(snippets[idx] if idx < len(snippets) else "")),
            }
        )
        if len(results) >= count:
            break
    return results


def parse_html(text, count):
    links = re.findall(
        r"<a[^>]*class=['\"]result__a['\"][^>]*href=['\"]([^'\"]+)['\"][^>]*>(.*?)</a>",
        text or "",
        re.I | re.S,
    )
    snippets = re.findall(
        r"<a[^>]*class=['\"]result__snippet['\"][^>]*>(.*?)</a>",
        text or "",
        re.I | re.S,
    )
    results = []
    seen = set()
    for idx, (url, title) in enumerate(links):
        real_url = normalize_ddg_url(url)
        clean_title = normalize_space(decode(title))
        if not real_url or real_url in seen or is_ad_or_internal_result(clean_title, real_url):
            continue
        seen.add(real_url)
        results.append(
            {
                "title": clean_title,
                "url": real_url,
                "snippet": normalize_space(decode(snippets[idx] if idx < len(snippets) else "")),
            }
        )
        if len(results) >= count:
            break
    return results


def search(query, count):
    attempts = []
    lite_data = urllib.parse.urlencode({"q": query}).encode()
    for name, url, data, parser in [
        ("duckduckgo-lite-post", "https://lite.duckduckgo.com/lite/", lite_data, parse_lite),
        ("duckduckgo-html-post", "https://html.duckduckgo.com/html/", lite_data, parse_html),
        ("duckduckgo-html-get", "https://html.duckduckgo.com/html/?" + urllib.parse.urlencode({"q": query}), None, parse_html),
    ]:
        try:
            text, status = request_text(url, data=data)
            if is_challenge(text):
                attempts.append({"engine": name, "status": status, "error": "anti-bot challenge"})
                continue
            results = parser(text, count)
            attempts.append({"engine": name, "status": status, "results": len(results)})
            if results:
                return {
                    "ok": True,
                    "query": query,
                    "engine": name,
                    "results": results,
                    "attempts": attempts,
                }
        except Exception as exc:
            attempts.append({"engine": name, "error": str(exc)[:500]})
    return {"ok": False, "query": query, "results": [], "attempts": attempts}


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"ok": False, "error": "usage: ddg_urllib_search.py <query> [count]"}, ensure_ascii=False))
        return 2
    query = sys.argv[1]
    try:
        count = max(1, min(int(sys.argv[2]) if len(sys.argv) > 2 else 5, 10))
    except ValueError:
        count = 5
    print(json.dumps(search(query, count), ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
