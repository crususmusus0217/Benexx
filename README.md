# 平塚 入荷メモ

Benex公式サイト（https://benex.co.jp/prizes）の景品入荷情報を1日2回取得し、
平塚店向けにスマホで検索できるページとして公開する。

## 構成
- `scripts/update.mjs` … 取得・差分検出・`site/data.json` 出力（依存なし）
- `site/index.html` … スマホ用の検索画面
- `data/state.json` … 初回検出日・入荷日変更の履歴（Actionsが自動コミット）
- `.github/workflows/update.yml` … 定期実行とGitHub Pagesへのデプロイ

## ローカル確認
    node scripts/update.mjs
    npx serve site        # または python -m http.server -d site

## 失敗時
抽出件数が50件未満だとスクリプトが異常終了し、Actionsの失敗通知メールが届く。
その場合は公式サイトの構造が変わっている可能性が高い。
