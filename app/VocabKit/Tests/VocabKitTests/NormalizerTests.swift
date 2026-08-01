import XCTest
@testable import VocabKit

/// `pipeline/test_normalizer.py` と同じケースを Swift 側でも通す。
/// 判定の不満に出会ったら、Python 側と両方に同じケースを追加すること。
final class NormalizerTests: XCTestCase {

    func testNormalize() {
        let expectations: [(String, String)] = [
            ("けんとうする", "けんとう"),
            ("けんとうすること", "けんとう"),
            ("じゅうような", "じゅうよう"),
            ("ゴール", "ごる"),          // 長音符は除去される
            ("をたすける", "たすける"),
            ("さかな", "さかな"),        // 3文字語は語尾除去で壊さない
            ("おんな", "おんな"),
        ]
        for (input, expected) in expectations {
            XCTAssertEqual(Normalizer.normalize(input), expected,
                           "normalize(\(input))")
        }
    }

    func testJudgeCorrect() {
        let cases: [(String, [String])] = [
            ("かんがえる", ["かんがえる", "おもう"]),
            ("けんとうする", ["けんとう"]),
            ("けんとう", ["けんとうする"]),
            ("じゅっこう", ["じゅっこうする"]),
            ("じゅうような", ["じゅうよう"]),
            ("じゅうよう", ["じゅうような"]),
            ("もくてき", ["きゃっかんてき", "もくてき", "ねらい"]),
            ("リンゴ", ["りんご"]),                 // カタカナ入力も救う
            ("ゴール", ["ごーる"]),
            (" かんがえる ", ["かんがえる"]),
            ("かんがえる。", ["かんがえる"]),
            ("をたすける", ["たすける"]),
            ("かんがえる、けんとうする", ["かんがえる"]),
            ("たすける/すくう", ["すくう"]),
            ("じゅつこうする", ["じゅっこうする"]),   // タイプミス許容
            ("きゃっかんてけ", ["きゃっかんてき"]),
            ("さかな", ["さかな"]),
        ]
        for (input, answers) in cases {
            XCTAssertEqual(Normalizer.judge(input, answers: answers), .correct,
                           "judge(\(input))")
        }
    }

    func testJudgeUnsure() {
        let cases: [(String, [String])] = [
            ("かんが", ["かんがえる"]),
            ("れきし", ["れきしてき"]),
            ("さかな", ["さか"]),
        ]
        for (input, answers) in cases {
            XCTAssertEqual(Normalizer.judge(input, answers: answers), .unsure,
                           "judge(\(input))")
        }
    }

    func testJudgeWrong() {
        let cases: [(String, [String])] = [
            ("はしる", ["かんがえる", "おもう"]),
            ("りんご", ["つくえ"]),
            ("うみ", ["やま"]),
            ("", ["かんがえる"]),
            ("かんがえる", []),
        ]
        for (input, answers) in cases {
            XCTAssertEqual(Normalizer.judge(input, answers: answers), .wrong,
                           "judge(\(input))")
        }
    }

    func testEditDistance() {
        func distance(_ a: String, _ b: String) -> Int {
            Normalizer.editDistance(Array(a.unicodeScalars),
                                    Array(b.unicodeScalars))
        }
        XCTAssertEqual(distance("かんがえる", "かんがえる"), 0)
        XCTAssertEqual(distance("かんがえる", "かんかえる"), 1)
        XCTAssertEqual(distance("かんがえる", ""), 5)
        XCTAssertEqual(distance("", "あい"), 2)
    }

    func testDistanceThreshold() {
        XCTAssertEqual(Normalizer.distanceThreshold(3), 0)
        XCTAssertEqual(Normalizer.distanceThreshold(6), 1)
        XCTAssertEqual(Normalizer.distanceThreshold(7), 2)
    }
}
