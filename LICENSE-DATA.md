# 単語データのライセンス — CC BY-SA 4.0

**このリポジトリのコードは MIT License ですが（[LICENSE](LICENSE)）、
下記の単語データは CC BY-SA 4.0 です。** 元データが CC BY-SA 4.0 であり、
その ShareAlike 条項により派生物も同ライセンスで提供する必要があるためです。

## 対象ファイル

```
out/vocabulary.json               単語データ
out/normalization_testcases.json  判定エンジンの検証ベクタ
out/scheduler_testcases.json      出題エンジンの検証ベクタ
out/ATTRIBUTION.md                出典表示
app/pwa/public/data/*             上記をアプリへ取り込んだもの
```

## ライセンス

Creative Commons Attribution-ShareAlike 4.0 International (CC BY-SA 4.0)

<https://creativecommons.org/licenses/by-sa/4.0/deed.ja>

## 出典

| データ | 提供者 | ライセンス |
|---|---|---|
| New General Service List (NGSL) 1.2 | Browne, C., Culligan, B., & Phillips, J. | CC BY-SA 4.0 |
| New Academic Word List (NAWL) 1.0 | 同上 | CC BY-SA 4.0 |
| JMdict / EDICT | Electronic Dictionary Research and Development Group (EDRDG) | CC BY-SA 4.0 |

- NGSL / NAWL: <https://www.newgeneralservicelist.com/>
- JMdict / EDICT: <https://www.edrdg.org/wiki/index.php/JMdict-EDICT_Dictionary_Project>

日本語訳および読みは JMdict のデータを基に、学習用に選別・編集したものです。

## 再配布・改変するときの条件

1. **表示 (BY)** — 上記の出典を明記すること
2. **継承 (SA)** — 改変した単語データも CC BY-SA 4.0 で提供すること
3. **アプリに組み込む場合は出典表示画面が必須** — EDRDG のライセンスは、
   起動画面での言及では不十分であり、「About」「情報」等のメニューから開ける
   独立した画面での表示を求めています。`out/ATTRIBUTION.md` の内容を
   そのまま組み込んでください（本アプリでは 設定 ＞ 出典・ライセンス）
4. 辞書データは定期的に最新版へ更新することが求められています

## 再配布しないもの

`sources/`（ダウンロードした元データそのもの）は再配布しません。
`pipeline/step1_fetch.py` で各提供元から取得してください。
