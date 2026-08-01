"""step1: 元データのダウンロード.

NGSL / NAWL / JMdict を sources/ に取得する。
サイト構成の変更で URL が死んでいても、手動配置の案内を出して止まる。
"""

from __future__ import annotations

import ssl
import sys
import urllib.error
import urllib.request

from config import SOURCE_FILES, SOURCE_URLS

UA = "Mozilla/5.0 (compatible; vocab-pipeline/1.0)"


def _download(url: str, dest, *, insecure: bool = False) -> None:
    ctx = None
    if insecure:
        # edrdg の ftp ホストは証明書の SAN が一致しないことがある。
        # 取得するのは公開辞書データのみなので、ここに限り検証を緩める。
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE

    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=120, context=ctx) as resp:
        data = resp.read()

    if not data:
        raise OSError("空のレスポンス")
    dest.write_bytes(data)


def fetch(name: str) -> bool:
    """候補 URL を順に試す。成功したら True."""
    dest = SOURCE_FILES[name]
    if dest.exists() and dest.stat().st_size > 0:
        print(f"  [skip] {name}: 取得済み ({dest.stat().st_size:,} bytes)")
        return True

    for url in SOURCE_URLS[name]:
        for insecure in (False, True):
            try:
                print(f"  [get ] {url}" + ("  (証明書検証なし)" if insecure else ""))
                _download(url, dest, insecure=insecure)
                print(f"  [ ok ] {name}: {dest.stat().st_size:,} bytes")
                return True
            except (urllib.error.URLError, OSError, ssl.SSLError) as e:
                reason = getattr(e, "reason", e)
                print(f"         失敗: {reason}")
                if not insecure:
                    continue
                break

    print(f"  [FAIL] {name}: 自動取得できませんでした")
    return False


MANUAL_HINTS = {
    "ngsl": (
        "https://www.newgeneralservicelist.com/new-general-service-list から\n"
        "       NGSL 1.2 の CSV をダウンロードし、sources/ngsl.csv として保存"
    ),
    "nawl": (
        "https://www.newgeneralservicelist.com/nawl-new-academic-word-list から\n"
        "       NAWL の CSV をダウンロードし、sources/nawl.csv として保存"
    ),
    "jmdict": (
        "http://ftp.edrdg.org/pub/Nihongo/JMdict_e.gz を\n"
        "       sources/JMdict_e.gz として保存"
    ),
}


def main() -> int:
    print("step1: 元データを取得します\n")
    failed = [name for name in SOURCE_FILES if not fetch(name)]

    if failed:
        print("\n以下は手動でダウンロードして配置してください:\n")
        for name in failed:
            print(f"  - {name}: {MANUAL_HINTS[name]}\n")
        return 1

    print("\nstep1 完了。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
