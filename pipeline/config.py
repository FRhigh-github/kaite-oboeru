"""パイプライン全体の設定."""

from pathlib import Path

# --- ディレクトリ ---
ROOT = Path(__file__).resolve().parent.parent
SOURCES = ROOT / "sources"   # ダウンロードした元データ（再配布しない）
BUILD = ROOT / "build"       # 中間生成物
OUT = ROOT / "out"           # アプリ同梱用の最終成果物

DATA = ROOT / "data"        # 手で編集する設定・補正データ（git 管理する）

for _d in (SOURCES, BUILD, OUT, DATA):
    _d.mkdir(parents=True, exist_ok=True)

# ルールで拾えなかった語・訳語がおかしい語を手で直すためのファイル。
# LLM を使わない構成では、ここが唯一の人手の逃げ道になる。
OVERRIDES_PATH = DATA / "manual_overrides.json"
# 要対応の語をテンプレートとして書き出す先
TODO_PATH = DATA / "needs_review.json"


# --- データソース ---
# いずれも CC BY-SA 4.0。出典表示と ShareAlike が必要（README 参照）。
NGSL_COM = "https://www.newgeneralservicelist.com"
NGSL_ORG = "https://www.newgeneralservicelist.org"

# 候補 URL は上から順に試す。サイト更新で 404 になっても手動配置でリカバリできる。
SOURCE_URLS = {
    "ngsl": [
        f"{NGSL_COM}/s/NGSL_12_stats.csv",
        f"{NGSL_ORG}/s/NGSL_12_stats.csv",
    ],
    "nawl": [
        # SFI 付き（頻度でティア分けできる）を優先し、なければ alphabetized txt。
        f"{NGSL_ORG}/s/NAWL_10_stats.csv",
        f"{NGSL_COM}/s/NAWL_10_stats.csv",
        f"{NGSL_ORG}/s/NAWL_10_alphabetized_description.txt",
    ],
    # JMdict_e = 英語 gloss のみの版（全言語版より大幅に軽い）
    "jmdict": [
        "http://ftp.edrdg.org/pub/Nihongo/JMdict_e.gz",
        "https://ftp.edrdg.org/pub/Nihongo/JMdict_e.gz",
    ],
}

SOURCE_FILES = {
    "ngsl": SOURCES / "ngsl.csv",
    "nawl": SOURCES / "nawl.csv",
    "jmdict": SOURCES / "JMdict_e.gz",
}


# --- 単語リスト構築のパラメータ ---

# 頻度上位このランクまでは「中学レベルの超基本語」として除外する。
# ターゲット1900 相当のレベル感に寄せるための調整ノブ。
BASIC_CUTOFF_RANK = 1400

# 最終的に収録する語数
TARGET_WORD_COUNT = 1900

# レベル分けの構成（合計が TARGET_WORD_COUNT になること）
TIERS = [
    ("part1", 600),  # 常に必須
    ("part2", 700),  # 差がつく
    ("part3", 600),  # 難関大レベル
]

# 学習単位のグループ。1グループずつ区切って覚えられるようにする。
# 頻度順に並んだ最終リストを先頭から等分する（グループ1が最も易しい）。
WORDS_PER_GROUP = 100

# NGSL と NAWL の SFI は別コーパス由来なので直接比較できない。
# （例: NAWL の repertoire は SFI 72.45 で NGSL の red 60.77 より「高頻度」に見えるが、
#   実際には repertoire の方が明らかに難しい。学術コーパス基準の頻度のため。）
# そこで各リスト内の順位を 0..1 に正規化し、NAWL には下駄を履かせて後段に寄せる。
#   NGSL 難易度 = 0 .. 1
#   NAWL 難易度 = NAWL_DIFFICULTY_OFFSET .. 1
# 0.35 なら「最頻出の学術語でも、一般語の下位35%相当の難しさ」という意味になる。
# part3 が学術語だらけになるようなら下げ、簡単すぎるなら上げる調整ノブ。
NAWL_DIFFICULTY_OFFSET = 0.35

# 出題対象にしない語（機能語・固有名詞的なもの）。
# NGSL は品詞情報が薄いので、明示的な除外リストで補う。
STOPWORDS = {
    "a", "an", "the", "and", "or", "but", "if", "of", "to", "in", "on", "at",
    "by", "for", "with", "about", "into", "from", "up", "down", "out", "off",
    "over", "under", "again", "then", "once", "here", "there", "when", "where",
    "why", "how", "all", "any", "both", "each", "few", "more", "most", "other",
    "some", "such", "no", "nor", "not", "only", "own", "same", "so", "than",
    "too", "very", "can", "will", "just", "should", "now", "i", "you", "he",
    "she", "it", "we", "they", "me", "him", "her", "us", "them", "my", "your",
    "his", "its", "our", "their", "this", "that", "these", "those", "am", "is",
    "are", "was", "were", "be", "been", "being", "have", "has", "had", "do",
    "does", "did", "would", "could", "shall", "may", "might", "must",
    "monday", "tuesday", "wednesday", "thursday", "friday", "saturday",
    "sunday", "january", "february", "march", "april", "may", "june", "july",
    "august", "september", "october", "november", "december",
}


# --- 訳語の選別（step3/step4）のパラメータ ---
# LLM は使わない。JMdict が語義ごとに持つタグで機械的に選別する。

MAX_GLOSS_CANDIDATES = 24   # 1単語あたり step3 が拾う候補の上限
MAX_ACCEPTED = 8            # 1単語あたりの許容解の上限

# 読みの長さでフィルタする。長すぎるものは単語ではなく句
# （例:「歴史の一ページ」= れきしのいちぺーじ）なので訳語として使わない。
MIN_READING_LEN = 2
MAX_READING_LEN = 12

# この misc タグが付く語義は捨てる。
#   arch/obs/dated/hist … 古語・廃語・歴史用語
#   rare               … 稀用
#   sl/net-sl/col      … 俗語・ネットスラング（口語 col は accepted 候補としてのみ残す）
#   vulg/derog/sens    … 卑語・侮蔑語
#   organization/work/company/product … 固有名詞
#   yoji/proverb/id    … 四字熟語・ことわざ・慣用句（単語の訳ではない）
#   hon/hum/pol/serv/fam … 敬語・謙譲語などの待遇表現
#   abbr               … 略語
DROP_MISC = {
    "arch", "obs", "dated", "hist", "rare", "obsc",
    "sl", "net-sl", "vulg", "derog", "sens", "joc", "poet",
    "organization", "work", "company", "product", "person", "place",
    "yoji", "proverb", "id", "on-mim",
    "hon", "hum", "pol", "serv", "fam", "male", "fem", "chn",
    "abbr",
}

# 口語表現は primary にはしないが、学習者が書きうるので accepted には残す。
DEMOTE_MISC = {"col"}

# field タグ（med, comp, law, Buddh ...）が付く語義は専門的すぎるので捨てる。
# ただし全候補が落ちてしまう場合は緩和する（step4 側で処理）。
DROP_ANY_FIELD = True

# 「uk」= usually written using kana alone。
# 漢字表記より かな表記が普通の語（然も→しかも、以て→もって など）。
# これらは表示にも かな を使う。
KANA_PREFERRED_TAG = "uk"
