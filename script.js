/**
 * 広告費ムダ診断ツール — script.js
 * ─────────────────────────────────────
 * 構成:
 *  1. 定数・ベンチマークデータ
 *  2. フォームUI操作
 *  3. 診断起動 & ローディングアニメーション
 *  4. LP URL解析（CORS proxy経由）
 *  5. KPI計算
 *  6. スコアリング
 *  7. 結果レンダリング
 *  8. Chart.js グラフ生成
 *  9. リード獲得
 * 10. ユーティリティ
 */

'use strict';

// ═══════════════════════════════════════════════════════════
// 1. ベンチマークデータ
// ═══════════════════════════════════════════════════════════

/**
 * 媒体別の業界平均指標
 * CVR: クリックから成約への転換率
 * CPC: クリック単価（円）
 */
const MEDIA_BENCHMARKS = {
  google: { name: 'Google広告',  avgCVR: 0.028, avgCPC: 220, color: '#4285F4' },
  yahoo:  { name: 'Yahoo!広告',  avgCVR: 0.022, avgCPC: 190, color: '#FF0033' },
  meta:   { name: 'Meta広告',    avgCVR: 0.013, avgCPC:  95, color: '#1877F2' },
  other:  { name: 'その他',       avgCVR: 0.015, avgCPC: 120, color: '#6B7280' },
};

/**
 * CPA改善可能性の業界統計
 * 広告の最適化によりこの割合の改善が期待できる
 */
const CPA_IMPROVEMENT_POTENTIAL = 0.35; // 35%改善可能（統計的中央値）

// ═══════════════════════════════════════════════════════════
// 2. 状態管理
// ═══════════════════════════════════════════════════════════

/** 診断データを格納するグローバル状態 */
let diagnosisData = null;

/** Chart.jsインスタンスを管理（重複生成防止） */
const chartInstances = {};

// ═══════════════════════════════════════════════════════════
// 3. フォームUI操作
// ═══════════════════════════════════════════════════════════

/**
 * 媒体タイルのトグル
 * @param {HTMLElement} tile - クリックされたタイル要素
 */
function initMediaTiles() {
  document.querySelectorAll('.media-tile').forEach(tile => {
    tile.addEventListener('click', () => {
      const cb = tile.querySelector('input[type="checkbox"]');
      cb.checked = !cb.checked;
      tile.classList.toggle('selected', cb.checked);
      document.getElementById('err-media').style.display = 'none';
    });
  });
}

/**
 * 広告費プリセットボタン
 * @param {number} amount - 金額（円）
 */
function setSpend(amount) {
  document.getElementById('input-spend').value = amount;
  document.getElementById('err-spend').style.display = 'none';
}

// URL入力時にhttpsプレフィックスを考慮
document.addEventListener('DOMContentLoaded', () => {
  initMediaTiles();

  const urlInput = document.getElementById('input-url');
  urlInput.addEventListener('input', () => {
    document.getElementById('err-url').style.display = 'none';
    document.getElementById('url-status').textContent = '';
    document.getElementById('url-status').className = 'url-status';
  });

  // 数値入力のエラークリア
  ['input-spend', 'input-cv'].forEach(id => {
    document.getElementById(id).addEventListener('input', () => {
      document.getElementById(`err-${id === 'input-spend' ? 'spend' : 'cv'}`).style.display = 'none';
    });
  });
});

// ═══════════════════════════════════════════════════════════
// 4. バリデーション
// ═══════════════════════════════════════════════════════════

/**
 * フォームの入力値を検証する
 * @returns {{ valid: boolean, url: string, media: string[], spend: number, cv: number }}
 */
function validateForm() {
  let valid = true;

  // URL
  const rawUrl = document.getElementById('input-url').value.trim();
  const url = rawUrl.startsWith('http') ? rawUrl : `https://${rawUrl}`;
  if (!rawUrl || !isValidUrl(url)) {
    document.getElementById('err-url').textContent = '正しいURLを入力してください（例: example.com/lp）';
    document.getElementById('err-url').style.display = 'block';
    valid = false;
  }

  // 媒体（1つ以上）
  const media = [...document.querySelectorAll('input[name="media"]:checked')].map(i => i.value);
  if (!media.length) {
    document.getElementById('err-media').textContent = '広告媒体を1つ以上選択してください';
    document.getElementById('err-media').style.display = 'block';
    valid = false;
  }

  // 広告費
  const spend = parseFloat(document.getElementById('input-spend').value);
  if (!spend || spend < 10000) {
    document.getElementById('err-spend').textContent = '月間広告費を入力してください（10,000円以上）';
    document.getElementById('err-spend').style.display = 'block';
    valid = false;
  }

  // CV数
  const cv = parseInt(document.getElementById('input-cv').value);
  if (!cv || cv < 1) {
    document.getElementById('err-cv').textContent = 'CV数を入力してください（1以上）';
    document.getElementById('err-cv').style.display = 'block';
    valid = false;
  }

  return { valid, url, media, spend, cv };
}

function isValidUrl(str) {
  try { new URL(str); return true; }
  catch (_) { return false; }
}

// ═══════════════════════════════════════════════════════════
// 5. 診断起動 & ローディング
// ═══════════════════════════════════════════════════════════

/**
 * 診断を開始する
 * バリデーション → ローディング表示 → LP解析 → 計算 → 結果表示
 */
async function startDiagnosis() {
  const { valid, url, media, spend, cv } = validateForm();
  if (!valid) return;

  // フォーム非表示・ローディング表示
  document.getElementById('form-section').style.display = 'none';
  const loadingSection = document.getElementById('loading-section');
  loadingSection.style.display = 'block';
  document.getElementById('loading-url').textContent = url;
  window.scrollTo({ top: 0, behavior: 'smooth' });

  // ローディングステップアニメーション（各ステップを順に点灯）
  const steps = [
    { id: 'ls-1', label: 'サイト構造解析',    status: '解析中...' },
    { id: 'ls-2', label: 'メタ情報取得',      status: '取得中...' },
    { id: 'ls-3', label: 'LP品質評価',       status: '評価中...' },
    { id: 'ls-4', label: '広告効率分析',      status: '計算中...' },
    { id: 'ls-5', label: '改善レポート生成',   status: '生成中...' },
  ];

  // ステップ1〜2はLPフェッチと並行して進める
  activateStep('ls-1', '解析中...');
  const lpDataPromise = fetchLPData(url);
  await sleep(800);
  completeStep('ls-1', '完了');

  activateStep('ls-2', '取得中...');
  const lpData = await lpDataPromise;  // フェッチ結果を待機
  await sleep(400);
  completeStep('ls-2', lpData.fetched ? '取得完了' : 'ヒューリスティック解析');

  activateStep('ls-3', '評価中...');
  await sleep(700);
  completeStep('ls-3', '完了');

  activateStep('ls-4', '計算中...');
  await sleep(600);
  completeStep('ls-4', '完了');

  activateStep('ls-5', '生成中...');
  await sleep(500);
  completeStep('ls-5', '完了');

  await sleep(300);

  // 計算・レンダリング
  const result = computeDiagnosis({ url, media, spend, cv, lpData });
  diagnosisData = result;

  loadingSection.style.display = 'none';
  renderResults(result);
}

/** ローディングステップを「進行中」状態にする */
function activateStep(id, statusText) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.add('active');
  el.querySelector('.ls-status').textContent = statusText;
}

/** ローディングステップを「完了」状態にする */
function completeStep(id, statusText) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.remove('active');
  el.classList.add('done');
  el.querySelector('.ls-status').textContent = statusText;
}

// ═══════════════════════════════════════════════════════════
// 6. LP URL 解析
// ═══════════════════════════════════════════════════════════

/**
 * LP URLのメタ情報を取得する
 * CORS proxy（allorigins.win）を経由してHTMLを取得・解析
 * 取得失敗時はURLパターンによるヒューリスティック解析にフォールバック
 *
 * @param {string} url - 解析対象URL
 * @returns {Promise<LPData>}
 */
async function fetchLPData(url) {
  try {
    // allorigins.win経由でHTMLを取得（CORSバイパス）
    const proxyUrl = `https://api.allorigins.win/get?url=${encodeURIComponent(url)}&timestamp=${Date.now()}`;
    const res = await fetch(proxyUrl, { signal: AbortSignal.timeout(8000) });
    const json = await res.json();

    if (!json.contents) throw new Error('Empty response');

    const parser = new DOMParser();
    const doc = parser.parseFromString(json.contents, 'text/html');

    return parseLPDocument(doc, url, true);
  } catch (err) {
    // フォールバック: URLパターンによる推定
    console.log('LP fetch failed, using heuristic:', err.message);
    return heuristicLPAnalysis(url);
  }
}

/**
 * 取得したDOMからLP情報を抽出する
 * @param {Document} doc
 * @param {string} url
 * @param {boolean} fetched - 実際に取得できたか
 * @returns {LPData}
 */
function parseLPDocument(doc, url, fetched) {
  const get = (sel) => doc.querySelector(sel)?.content?.trim() || '';
  const getText = (sel) => doc.querySelector(sel)?.textContent?.trim() || '';

  const title       = getText('title');
  const metaDesc    = get('meta[name="description"]');
  const h1          = getText('h1');
  const h2s         = [...doc.querySelectorAll('h2')].map(el => el.textContent.trim()).filter(Boolean);
  const ogTitle     = get('meta[property="og:title"]');
  const ogDesc      = get('meta[property="og:description"]');
  const bodyText    = doc.body?.textContent?.trim() || '';
  const charCount   = bodyText.replace(/\s+/g, '').length;

  // CTAワード検索（ボタン・リンクのテキスト）
  const ctaWords    = ['無料', '体験', '相談', '予約', '申し込み', '問い合わせ', '購入', '注文', '登録', 'お試し'];
  const allBtnText  = [...doc.querySelectorAll('button, .btn, .cta, a[href*="contact"], a[href*="form"], a[href*="apply"]')]
    .map(el => el.textContent.trim()).join(' ');
  const ctaFound    = ctaWords.filter(w => allBtnText.includes(w) || bodyText.includes(w));
  const ctaCount    = ctaFound.length;

  // タイトルタイプ分類
  const titleType   = classifyTitleType(title || h1 || ogTitle);

  return {
    fetched,
    url,
    title:    title   || ogTitle  || '（取得できませんでした）',
    metaDesc: metaDesc || ogDesc  || '（取得できませんでした）',
    h1:       h1      || '（取得できませんでした）',
    h2s:      h2s.slice(0, 5),
    charCount,
    ctaCount,
    ctaFound,
    titleType,
    hasHTTPS: url.startsWith('https://'),
  };
}

/**
 * URLパターンによるヒューリスティック解析（フォールバック用）
 * @param {string} url
 * @returns {LPData}
 */
function heuristicLPAnalysis(url) {
  const u = url.toLowerCase();
  const isLP        = /\/(lp|landing|campaign|ad|ads)\b/.test(u);
  const isTopPage   = (u.match(/\//g)||[]).length <= 3 && !isLP;
  const hasHTTPS    = u.startsWith('https://');

  // URL構造からCTA・情報量を推定
  const ctaCount    = isLP ? 3 : isTopPage ? 1 : 2;
  const charCount   = isLP ? 3000 : isTopPage ? 1200 : 1800;

  // URLからタイプ推定
  const titleType   = isTopPage ? 'brand' : 'feature';

  return {
    fetched: false,
    url,
    title:    '（URL解析：フォールバックモード）',
    metaDesc: 'URLパターンに基づく推定診断です',
    h1:       '—',
    h2s:      [],
    charCount,
    ctaCount,
    ctaFound: ctaCount > 1 ? ['無料', '申し込み'] : [],
    titleType,
    hasHTTPS,
    isHeuristic: true,
    isLP,
    isTopPage,
  };
}

/**
 * タイトルをタイプ分類する
 * @param {string} title
 * @returns {'benefit'|'feature'|'brand'}
 */
function classifyTitleType(title) {
  if (!title) return 'unknown';
  const t = title;
  // ベネフィット型: 効果・変化・ユーザーメリットを前面に出す
  if (/解決|改善|向上|増加|削減|節約|稼ぐ|結果|成果|効果|得|お得|簡単|すぐ|即|確実/.test(t)) return 'benefit';
  // ブランド型: 企業名・サービス名が主体
  if (/株式会社|合同会社|\.com|サービス名|公式|オフィシャル/.test(t)) return 'brand';
  // 機能説明型: 機能・仕様・スペックが主体
  return 'feature';
}

// ═══════════════════════════════════════════════════════════
// 7. KPI計算・スコアリング
// ═══════════════════════════════════════════════════════════

/**
 * 診断データを計算する
 * @param {object} input - { url, media, spend, cv, lpData }
 * @returns {DiagnosisResult}
 */
function computeDiagnosis({ url, media, spend, cv, lpData }) {
  // ── ベンチマーク計算（選択媒体の加重平均） ──
  const benchmarks = media.map(m => MEDIA_BENCHMARKS[m] || MEDIA_BENCHMARKS.other);
  const avgBenchCVR = benchmarks.reduce((s, b) => s + b.avgCVR, 0) / benchmarks.length;
  const avgBenchCPC = benchmarks.reduce((s, b) => s + b.avgCPC, 0) / benchmarks.length;

  // ── KPI計算 ──
  // CPA = 広告費 ÷ CV数
  const cpa = Math.round(spend / cv);

  // クリック数の推定（CPC × クリック数 = 広告費 より推定）
  const estimatedClicks = Math.round(spend / avgBenchCPC);

  // CVR = CV数 ÷ 推定クリック数（%表示）
  const cvr = estimatedClicks > 0 ? (cv / estimatedClicks) * 100 : 0;

  // CPC = 広告費 ÷ 推定クリック数
  const cpc = avgBenchCPC;  // 業界平均CPCを使用（実クリック数不明のため）

  // 業界平均CPA = 業界平均CPC ÷ 業界平均CVR
  const benchCPA = Math.round(avgBenchCPC / avgBenchCVR);
  const benchCVR = avgBenchCVR * 100;  // % 表示

  // ── 改善余地計算 ──
  // 改善後CPA = 現CPA × (1 - 改善率)
  const improvedCPA    = Math.round(cpa * (1 - CPA_IMPROVEMENT_POTENTIAL));
  // 同じ広告費でのCV数改善
  const improvedCV     = Math.round(spend / improvedCPA);
  const cvIncrease     = improvedCV - cv;
  // 月間・年間の改善余地（金額）
  const monthlyWaste   = Math.max(0, cpa - benchCPA) * cv;
  const annualSavings  = monthlyWaste * 12;
  // 改善ポテンシャル（%）
  const improvePotential = cpa > benchCPA
    ? Math.min(Math.round((1 - benchCPA / cpa) * 100), 80)
    : Math.round(CPA_IMPROVEMENT_POTENTIAL * 100);

  // ── LP品質スコア（0〜100） ──
  const lpScore = computeLPScore(lpData);

  // ── 広告効率スコア（0〜100） ──
  const adScore = computeAdScore({ cpa, benchCPA, cvr, benchCVR, lpScore });

  // ── 改善ポイントリスト ──
  const improvements = buildImprovements({ cpa, benchCPA, cvr, benchCVR, lpData, adScore });

  return {
    // 入力値
    url, media, spend, cv, lpData,
    // KPI
    cpa, cvr, cpc, benchCPA, benchCVR, benchCPC: avgBenchCPC,
    estimatedClicks,
    // 改善余地
    improvedCPA, improvedCV, cvIncrease,
    monthlyWaste, annualSavings, improvePotential,
    // スコア
    adScore, lpScore,
    improvements,
    // 媒体情報
    mediaNames: media.map(m => (MEDIA_BENCHMARKS[m] || MEDIA_BENCHMARKS.other).name),
  };
}

/**
 * LP品質スコアを算出する（0〜100）
 * 評価軸: タイトル・CTA・情報量・構造
 */
function computeLPScore(lp) {
  let score = 0;

  // ① タイトルタイプ（25点）
  if (lp.titleType === 'benefit') score += 25;
  else if (lp.titleType === 'feature') score += 15;
  else if (lp.titleType === 'brand') score += 8;
  else score += 10;

  // ② CTA強度（30点）
  if (lp.ctaCount >= 6) score += 30;
  else if (lp.ctaCount >= 3) score += 22;
  else if (lp.ctaCount >= 1) score += 12;
  else score += 2;

  // ③ 情報量（25点）
  if (lp.charCount >= 4000) score += 25;
  else if (lp.charCount >= 1500) score += 18;
  else if (lp.charCount >= 500) score += 10;
  else score += 4;

  // ④ 構造（20点）
  const h2Count = lp.h2s?.length || 0;
  if (h2Count >= 5) score += 20;
  else if (h2Count >= 3) score += 15;
  else if (h2Count >= 1) score += 10;
  else score += 4;

  // HTTPS補正
  if (!lp.hasHTTPS) score = Math.max(0, score - 10);

  return Math.min(100, Math.round(score));
}

/**
 * 広告効率スコアを算出する（0〜100）
 */
function computeAdScore({ cpa, benchCPA, cvr, benchCVR, lpScore }) {
  let score = 0;

  // CPA評価（40点）: benchの何倍か
  const cpaRatio = cpa / benchCPA;
  if (cpaRatio <= 0.7) score += 40;
  else if (cpaRatio <= 0.9) score += 33;
  else if (cpaRatio <= 1.1) score += 26;
  else if (cpaRatio <= 1.5) score += 16;
  else if (cpaRatio <= 2.0) score += 9;
  else score += 2;

  // CVR評価（30点）
  const cvrRatio = cvr / benchCVR;
  if (cvrRatio >= 1.5) score += 30;
  else if (cvrRatio >= 1.0) score += 23;
  else if (cvrRatio >= 0.7) score += 16;
  else if (cvrRatio >= 0.5) score += 9;
  else score += 3;

  // LP品質（20点）
  score += Math.round(lpScore * 0.2);

  // 改善余地（10点）: CPA < benchなら満点
  score += cpa <= benchCPA ? 10 : Math.max(0, Math.round(10 * (1 - (cpa - benchCPA) / benchCPA)));

  return Math.min(100, Math.max(0, Math.round(score)));
}

/**
 * 改善ポイントリストを生成する
 */
function buildImprovements({ cpa, benchCPA, cvr, benchCVR, lpData, adScore }) {
  const items = [];
  const cpaRatio = cpa / benchCPA;
  const cvrRatio = cvr / benchCVR;

  // CPA系の問題
  if (cpaRatio > 1.5) {
    items.push({
      severity: 'critical',
      icon: '🚨',
      badge: '最重要',
      title: 'CPAが業界平均の' + cpaRatio.toFixed(1) + '倍に達しています',
      body: `現在のCPA ¥${fmtNum(cpa)} は業界平均 ¥${fmtNum(benchCPA)} より ${Math.round((cpaRatio-1)*100)}% 高い状態です。毎月の損失を回収するため、入札戦略の見直しとLP改善を最優先で行ってください。`,
    });
  } else if (cpaRatio > 1.1) {
    items.push({
      severity: 'major',
      icon: '⚠️',
      badge: '重要',
      title: 'CPAが業界平均をやや上回っています',
      body: `現在のCPA ¥${fmtNum(cpa)} は改善余地があります。除外キーワードの追加・入札調整・クリエイティブのA/Bテストで ¥${fmtNum(benchCPA)} 近辺まで改善を目指してください。`,
    });
  }

  // CVR系の問題
  if (cvrRatio < 0.7) {
    items.push({
      severity: 'critical',
      icon: '📉',
      badge: '最重要',
      title: 'CVR（成約率）が業界平均を大幅に下回っています',
      body: `推定CVR ${cvr.toFixed(2)}% は業界平均 ${benchCVR.toFixed(2)}% の ${Math.round(cvrRatio*100)}% にとどまっています。LPのファーストビュー・CTA・フォーム設計の改善でCV数を増やすことが最優先です。`,
    });
  } else if (cvrRatio < 1.0) {
    items.push({
      severity: 'major',
      icon: '📊',
      badge: '重要',
      title: 'CVRに改善余地があります',
      body: `推定CVR ${cvr.toFixed(2)}% を業界平均 ${benchCVR.toFixed(2)}% 以上に引き上げることで、同じ広告費でのCV数が増加します。LP上のCTAの数・配置・文言を最適化してください。`,
    });
  }

  // CTA問題
  if (lpData.ctaCount < 2) {
    items.push({
      severity: 'critical',
      icon: '🔘',
      badge: '緊急',
      title: 'LPのCTAが不足しています',
      body: `検出されたCTA数は ${lpData.ctaCount} 個です（目安: 3〜6個）。「無料相談」「資料請求」などのCTAボタンをページ内に複数配置し、ユーザーが迷わず行動できる設計にしてください。`,
    });
  }

  // タイトルタイプ問題
  if (lpData.titleType !== 'benefit') {
    items.push({
      severity: lpData.titleType === 'brand' ? 'critical' : 'major',
      icon: '📝',
      badge: lpData.titleType === 'brand' ? '重要' : '改善推奨',
      title: `タイトルが「${lpData.titleType === 'brand' ? 'ブランド型' : '機能説明型'}」になっています`,
      body: `タイトルはユーザーの「得られる価値・変化」を伝える「ベネフィット型」が最もCV率を高めます。例：「○○を使って売上が2倍に」など、結果・効果を前面に出した訴求に変更してください。`,
    });
  }

  // 情報量問題
  if (lpData.charCount < 1500) {
    items.push({
      severity: 'major',
      icon: '📄',
      badge: '改善推奨',
      title: 'LP情報量が不足しています',
      body: `推定文字数 ${fmtNum(lpData.charCount)} 文字は「情報不足」の水準です（目安: 1,500〜4,000文字）。サービスの説明・実績・FAQ・お客様の声などを追加し、ユーザーの疑問を解消してください。`,
    });
  }

  // HTTPS問題
  if (!lpData.hasHTTPS) {
    items.push({
      severity: 'critical',
      icon: '🔒',
      badge: '緊急',
      title: 'HTTPSが確認できません（セキュリティ警告リスク）',
      body: 'HTTPのLPはブラウザに「保護されていない通信」と表示され、ユーザーの離脱を招きます。SSL化（HTTPS対応）を今すぐ実施してください。CVRへの影響は非常に大きいです。',
    });
  }

  // 良好な場合のフィードバック
  if (items.length === 0) {
    items.push({
      severity: 'minor',
      icon: '✅',
      badge: '良好',
      title: '現在の指標は業界水準内です',
      body: 'CPAとCVRは業界平均水準内です。次のステップとしてROASの最大化・新規クリエイティブのA/Bテスト・類似オーディエンス展開を検討してください。',
    });
  }

  // 追加の共通改善提案
  items.push({
    severity: 'minor',
    icon: '🎯',
    badge: '推奨',
    title: 'クリエイティブのA/Bテストを実施する',
    body: '同じ広告費でもクリエイティブの違いでCTRが2〜3倍変わります。画像・見出し・CTA文言を変えた複数パターンを同時に配信し、勝ちパターンを特定してください。',
  });

  items.push({
    severity: 'minor',
    icon: '🔍',
    badge: '推奨',
    title: '除外キーワード・オーディエンスを最適化する',
    body: '無駄なクリックを除外するだけでCPAが10〜20%改善するケースがあります。検索クエリレポートを確認し、成果につながっていないキーワードを除外設定してください。',
  });

  return items;
}

// ═══════════════════════════════════════════════════════════
// 8. 結果レンダリング
// ═══════════════════════════════════════════════════════════

/**
 * 診断結果をDOMに描画する
 * @param {DiagnosisResult} d
 */
function renderResults(d) {
  const section = document.getElementById('results-section');
  section.style.display = 'block';
  section.scrollIntoView({ behavior: 'smooth', block: 'start' });

  // ① スコアヒーロー
  renderScoreHero(d);

  // ② KPIカード
  renderKPICards(d);

  // ③ ベンチマーク比較グラフ
  renderBenchmarkCharts(d);

  // ④ ムダ可視化
  renderWasteVisual(d);

  // ⑤ 年間改善余地バナー
  renderSavingsBanner(d);

  // ⑥ LP診断
  renderLPDiagnosis(d);

  // ⑦ 改善ポイント
  renderImprovements(d);

  // ⑧ メインCTA personalisation
  renderCTA(d);

  // スティッキーCTA
  if (d.annualSavings > 0) {
    const stickyCta = document.getElementById('sticky-cta');
    document.getElementById('sticky-text').textContent =
      `年間 ¥${fmtNum(d.annualSavings)} がムダに — 今すぐ無料で止める方法を確認する`;
    stickyCta.style.display = 'flex';
  }
}

/** ① スコアヒーロー */
function renderScoreHero(d) {
  const score = d.adScore;
  let grade, desc, gradeHtml;

  if (score >= 85) {
    gradeHtml = `<span class="grade-good">ムダなし · 非常に優秀 🏆</span>`;
    desc = '広告費のムダはほぼない状態です。さらなるスケールに向けた戦略を検討しましょう。';
  } else if (score >= 70) {
    gradeHtml = `<span class="grade-good">ムダ少 · 概ね良好 ✓</span>`;
    desc = '広告費のムダは少ない水準ですが、一部改善でさらに削減できる可能性があります。';
  } else if (score >= 50) {
    gradeHtml = `<span class="grade-red">広告費がムダになっています ⚠️</span>`;
    desc = '毎月の広告費の一部がムダになっています。早急な改善で損失を回収できます。';
  } else {
    gradeHtml = `<span class="grade-red">広告費の大部分がムダです 🚨</span>`;
    desc = '広告費が大幅にムダになっています。放置するほど損失が拡大します。今すぐ改善が必要です。';
  }

  document.getElementById('rsh-grade').innerHTML = gradeHtml;
  document.getElementById('rsh-desc').textContent = desc;

  // Waste banner
  if (d.monthlyWaste > 0) {
    document.getElementById('rsh-waste-text').textContent =
      `毎月 約¥${fmtNum(d.monthlyWaste)} が広告費のムダとして垂れ流されています`;
    document.getElementById('rsh-waste-banner').style.display = 'flex';
  }

  // スコア色
  const scoreColor = score >= 70 ? '#0d8a5a' : score >= 50 ? '#c07a00' : '#c42010';

  // ドーナツチャート
  destroyChart('score-donut');
  chartInstances['score-donut'] = new Chart(
    document.getElementById('chart-score-donut').getContext('2d'), {
      type: 'doughnut',
      data: {
        datasets: [{
          data: [score, 100 - score],
          backgroundColor: [scoreColor, 'rgba(255,255,255,.07)'],
          borderWidth: 0,
          borderRadius: [5, 0],
          hoverOffset: 0,
        }],
      },
      options: {
        cutout: '74%',
        responsive: false,
        animation: { duration: 1400, easing: 'easeInOutQuart' },
        plugins: { legend: { display: false }, tooltip: { enabled: false } },
      },
    }
  );

  // スコアカウントアップアニメーション
  let cur = 0;
  const ticker = setInterval(() => {
    cur = Math.min(cur + Math.ceil(score / 65), score);
    document.getElementById('score-display').textContent = cur;
    if (cur >= score) clearInterval(ticker);
  }, 18);
}

/** ② KPIカード */
function renderKPICards(d) {
  const cpaClass = d.cpa <= d.benchCPA * 1.1 ? 'good' : d.cpa <= d.benchCPA * 1.5 ? 'warn' : 'bad';
  const cvrClass = d.cvr >= d.benchCVR * 0.9 ? 'good' : d.cvr >= d.benchCVR * 0.6 ? 'warn' : 'bad';

  const cards = [
    {
      cls:     cpaClass,
      label:   'CPA（獲得単価）',
      value:   `¥${fmtNum(d.cpa)}`,
      bench:   `業界平均: ¥${fmtNum(d.benchCPA)}`,
      status:  d.cpa <= d.benchCPA * 1.1 ? '✓ 適正水準' : d.cpa <= d.benchCPA * 1.5 ? '△ 改善余地' : '⚠ 要改善',
      explain: 'CPA = 広告費 ÷ CV数。1件の成果を獲得するのにかかったコストです。',
    },
    {
      cls:     cvrClass,
      label:   'CVR（成約率・推定）',
      value:   `${d.cvr.toFixed(2)}%`,
      bench:   `業界平均: ${d.benchCVR.toFixed(2)}%`,
      status:  d.cvr >= d.benchCVR * 0.9 ? '✓ 適正水準' : d.cvr >= d.benchCVR * 0.6 ? '△ 改善余地' : '⚠ 要改善',
      explain: 'CVR = CV数 ÷ クリック数。広告をクリックした人が成約した割合（業界平均CPCから推定）。',
    },
    {
      cls:     'warn',
      label:   'CPC（クリック単価・参考）',
      value:   `¥${fmtNum(d.cpc)}`,
      bench:   `業界平均: ¥${fmtNum(d.benchCPC)}`,
      status:  '— 業界平均参考値',
      explain: 'CPC = 広告費 ÷ クリック数。1クリックあたりのコストです（選択媒体の平均値）。',
    },
  ];

  document.getElementById('kpi-grid').innerHTML = cards.map(c => `
    <div class="kpi-card ${c.cls}">
      <div class="kpi-label">${c.label}</div>
      <div class="kpi-value">${c.value}</div>
      <div class="kpi-bench">${c.bench}</div>
      <div class="kpi-status">${c.status}</div>
      <div class="kpi-explain">${c.explain}</div>
    </div>
  `).join('');
}

/** ③ ベンチマーク比較グラフ */
function renderBenchmarkCharts(d) {
  // CPA比較
  destroyChart('cpa');
  chartInstances['cpa'] = new Chart(
    document.getElementById('chart-cpa').getContext('2d'), {
      type: 'bar',
      data: {
        labels: ['あなたのCPA', '業界平均CPA'],
        datasets: [{
          data: [d.cpa, d.benchCPA],
          backgroundColor: [
            d.cpa > d.benchCPA ? 'rgba(196,32,16,.85)' : 'rgba(13,138,90,.85)',
            'rgba(26,79,214,.65)',
          ],
          borderRadius: 5,
          barThickness: 52,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: { label: c => `¥${c.raw.toLocaleString()}` },
          },
        },
        scales: {
          y: {
            beginAtZero: true,
            grid: { color: 'rgba(0,0,0,.05)' },
            ticks: {
              callback: v => `¥${(v >= 10000 ? (v/10000).toFixed(0)+'万' : v.toLocaleString())}`,
              font: { family: 'JetBrains Mono', size: 10 },
            },
          },
          x: {
            grid: { display: false },
            ticks: { font: { family: 'Noto Sans JP', size: 11 } },
          },
        },
      },
    }
  );

  // CVR比較
  destroyChart('cvr');
  chartInstances['cvr'] = new Chart(
    document.getElementById('chart-cvr').getContext('2d'), {
      type: 'bar',
      data: {
        labels: ['あなたのCVR（推定）', '業界平均CVR'],
        datasets: [{
          data: [+d.cvr.toFixed(2), +d.benchCVR.toFixed(2)],
          backgroundColor: [
            d.cvr >= d.benchCVR * 0.9 ? 'rgba(13,138,90,.85)' : 'rgba(196,32,16,.85)',
            'rgba(26,79,214,.65)',
          ],
          borderRadius: 5,
          barThickness: 52,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: c => `${c.raw}%` } },
        },
        scales: {
          y: {
            beginAtZero: true,
            grid: { color: 'rgba(0,0,0,.05)' },
            ticks: {
              callback: v => `${v}%`,
              font: { family: 'JetBrains Mono', size: 10 },
            },
          },
          x: {
            grid: { display: false },
            ticks: { font: { family: 'Noto Sans JP', size: 11 } },
          },
        },
      },
    }
  );
}

/** ④ ムダ可視化 */
function renderWasteVisual(d) {
  const wasteEl = document.getElementById('waste-visual');
  const ratioPct = Math.round(d.improvePotential);
  const currentCV = d.cv;
  const improvedCV = d.improvedCV;

  wasteEl.innerHTML = `
    <div class="wv-comparison">
      <div class="wv-current">
        <div class="wv-side-label">現在のCPA</div>
        <div class="wv-side-val">¥${fmtNum(d.cpa)}</div>
        <div class="wv-side-sub">月間 ${currentCV}件 獲得</div>
      </div>
      <div class="wv-arrow">
        <div>→</div>
        <div class="wv-arrow-label">CPA${ratioPct}%改善</div>
      </div>
      <div class="wv-target">
        <div class="wv-side-label">改善後のCPA（試算）</div>
        <div class="wv-side-val">¥${fmtNum(d.improvedCPA)}</div>
        <div class="wv-side-sub">同じ広告費で ${improvedCV}件 獲得</div>
      </div>
    </div>
    <div class="wv-result-bar">
      <div class="wv-rb-item">
        <div class="wv-rb-label">CV数増加</div>
        <div class="wv-rb-val up">+${d.cvIncrease}件/月</div>
      </div>
      <div class="wv-rb-item">
        <div class="wv-rb-label">月間改善余地</div>
        <div class="wv-rb-val down">¥${fmtNum(d.monthlyWaste)}</div>
      </div>
      <div class="wv-rb-item">
        <div class="wv-rb-label">年間改善余地</div>
        <div class="wv-rb-val down">¥${fmtNum(d.annualSavings)}</div>
      </div>
      <div class="wv-rb-item">
        <div class="wv-rb-label">改善ポテンシャル</div>
        <div class="wv-rb-val up">${ratioPct}%</div>
      </div>
    </div>
  `;

  // 改善ポテンシャルグラフ
  destroyChart('potential');
  const labels = ['現在', 'LP改善後', '入札最適化後', 'クリエイティブ改善後', '完全最適化後'];
  const cpaVals = [
    d.cpa,
    Math.round(d.cpa * 0.85),
    Math.round(d.cpa * 0.75),
    Math.round(d.cpa * 0.68),
    d.improvedCPA,
  ];
  chartInstances['potential'] = new Chart(
    document.getElementById('chart-potential').getContext('2d'), {
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label: 'CPA（円）',
            data: cpaVals,
            borderColor: '#e8500a',
            backgroundColor: 'rgba(232,80,10,.08)',
            borderWidth: 2.5,
            pointRadius: 5,
            pointBackgroundColor: '#e8500a',
            fill: true,
            tension: 0.35,
          },
          {
            label: '業界平均CPA',
            data: Array(labels.length).fill(d.benchCPA),
            borderColor: 'rgba(26,79,214,.5)',
            borderWidth: 1.5,
            borderDash: [6, 4],
            pointRadius: 0,
            fill: false,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { labels: { font: { family: 'Noto Sans JP', size: 11 }, color: '#555' } },
          tooltip: { callbacks: { label: c => `¥${c.raw.toLocaleString()}` } },
        },
        scales: {
          y: {
            beginAtZero: false,
            grid: { color: 'rgba(0,0,0,.05)' },
            ticks: {
              callback: v => `¥${v.toLocaleString()}`,
              font: { family: 'JetBrains Mono', size: 10 },
            },
          },
          x: {
            grid: { display: false },
            ticks: { font: { family: 'Noto Sans JP', size: 10 } },
          },
        },
      },
    }
  );
}

/** ⑤ 年間改善余地バナー */
function renderSavingsBanner(d) {
  document.getElementById('sb-amount').textContent = `¥${fmtNum(d.annualSavings)} / 年`;
  document.getElementById('sb-desc').textContent =
    d.annualSavings > 0
      ? `毎月 ¥${fmtNum(d.monthlyWaste)} × 12ヶ月 = 年間 ¥${fmtNum(d.annualSavings)} が広告費のムダとして垂れ流されています。CPA ${d.improvePotential}% 改善で取り戻せます。`
      : '現時点でのCPAはムダが少ない水準です。CVR改善でさらに広告費を有効活用できます。';

  // 広告費内訳ドーナツ
  const wasteRatio = Math.min(d.improvePotential / 100, 0.8);
  const effectiveRatio = 1 - wasteRatio;
  destroyChart('waste-donut');
  chartInstances['waste-donut'] = new Chart(
    document.getElementById('chart-waste-donut').getContext('2d'), {
      type: 'doughnut',
      data: {
        labels: ['有効な広告費', 'ムダになっている広告費（推計）'],
        datasets: [{
          data: [Math.round(effectiveRatio * 100), Math.round(wasteRatio * 100)],
          backgroundColor: ['rgba(13,138,90,.75)', 'rgba(232,80,10,.75)'],
          borderWidth: 0,
          borderRadius: 3,
        }],
      },
      options: {
        cutout: '60%',
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            position: 'bottom',
            labels: { font: { family: 'Noto Sans JP', size: 10 }, color: 'rgba(255,255,255,.5)', padding: 8 },
          },
          tooltip: { callbacks: { label: c => `${c.label}: ${c.raw}%` } },
        },
      },
    }
  );
}

/** ⑥ LP診断 */
function renderLPDiagnosis(d) {
  const lp = d.lpData;
  const lpScore = d.lpScore;

  document.getElementById('lp-url-display').textContent = lp.url;

  const lpVerdict = lpScore >= 75 ? '品質良好 — さらなる最適化でCVR向上が見込めます'
    : lpScore >= 55 ? '改善余地あり — 以下の項目を修正することでCVRが向上します'
    : '品質に課題あり — 以下の改善が急務です。LPを修正するだけでCV数が増える可能性があります';
  document.getElementById('lp-score-verdict').textContent = lpVerdict;

  // LP品質スコアドーナツ
  const lpColor = lpScore >= 70 ? '#0d8a5a' : lpScore >= 50 ? '#c07a00' : '#c42010';
  destroyChart('lp-donut');
  chartInstances['lp-donut'] = new Chart(
    document.getElementById('chart-lp-donut').getContext('2d'), {
      type: 'doughnut',
      data: {
        datasets: [{
          data: [lpScore, 100 - lpScore],
          backgroundColor: [lpColor, 'rgba(8,13,26,.07)'],
          borderWidth: 0,
          borderRadius: [3, 0],
        }],
      },
      options: {
        cutout: '70%',
        responsive: false,
        animation: { duration: 1200, easing: 'easeInOutQuart' },
        plugins: { legend: { display: false }, tooltip: { enabled: false } },
      },
    }
  );

  // スコアカウントアップ
  let cur = 0;
  const t = setInterval(() => {
    cur = Math.min(cur + Math.ceil(lpScore / 50), lpScore);
    document.getElementById('lp-score-display').textContent = cur;
    if (cur >= lpScore) clearInterval(t);
  }, 22);

  // 評価軸バー
  const titleScore = lp.titleType === 'benefit' ? 90 : lp.titleType === 'feature' ? 55 : 30;
  const ctaScore   = lp.ctaCount >= 6 ? 100 : lp.ctaCount >= 3 ? 75 : lp.ctaCount >= 1 ? 40 : 10;
  const infoScore  = lp.charCount >= 4000 ? 100 : lp.charCount >= 1500 ? 70 : lp.charCount >= 500 ? 40 : 15;
  const strScore   = (lp.h2s?.length || 0) >= 5 ? 100 : (lp.h2s?.length || 0) >= 3 ? 75 : (lp.h2s?.length || 0) >= 1 ? 50 : 20;

  const factors = [
    { name: 'タイトル訴求',  score: titleScore, color: titleScore >= 70 ? '#0d8a5a' : titleScore >= 45 ? '#c07a00' : '#c42010' },
    { name: 'CTA強度',      score: ctaScore,   color: ctaScore   >= 70 ? '#0d8a5a' : ctaScore   >= 45 ? '#c07a00' : '#c42010' },
    { name: '情報量',        score: infoScore,  color: infoScore  >= 70 ? '#0d8a5a' : infoScore  >= 45 ? '#c07a00' : '#c42010' },
    { name: 'ページ構造',    score: strScore,   color: strScore   >= 70 ? '#0d8a5a' : strScore   >= 45 ? '#c07a00' : '#c42010' },
  ];

  document.getElementById('lp-factors').innerHTML = factors.map(f => `
    <div class="lp-factor-row">
      <div class="lf-name">${f.name}</div>
      <div class="lf-bar-wrap"><div class="lf-bar" style="width:0%;background:${f.color};" data-w="${f.score}"></div></div>
      <div class="lf-score" style="color:${f.color};">${f.score}</div>
    </div>
  `).join('');

  // バーアニメーション
  setTimeout(() => {
    document.querySelectorAll('.lf-bar').forEach(b => {
      b.style.width = b.dataset.w + '%';
    });
  }, 200);

  // 取得したメタ情報の表示（実際に取得できた場合のみ）
  if (lp.fetched && lp.title !== '（取得できませんでした）') {
    const infoHtml = `
      <div class="lp-fetched-info">
        <div class="lpi-row"><span class="lpi-key">TITLE</span><br>${escHtml(lp.title)}</div>
        ${lp.metaDesc ? `<div class="lpi-row"><span class="lpi-key">DESCRIPTION</span><br>${escHtml(lp.metaDesc)}</div>` : ''}
        ${lp.h1 ? `<div class="lpi-row"><span class="lpi-key">H1</span><br>${escHtml(lp.h1)}</div>` : ''}
        ${lp.h2s?.length ? `<div class="lpi-row"><span class="lpi-key">H2（最初の3件）</span><br>${lp.h2s.slice(0,3).map(h=>escHtml(h)).join('<br>')}</div>` : ''}
        <div class="lpi-row"><span class="lpi-key">タイトルタイプ</span> ${titleTypeLabel(lp.titleType)} · <span class="lpi-key">CTA数</span> ${lp.ctaCount}個 · <span class="lpi-key">文字数</span> 約${fmtNum(lp.charCount)}字</div>
      </div>
    `;
    document.getElementById('lp-section').querySelector('.section-block')?.insertAdjacentHTML?.('beforeend', infoHtml);
    // ↑ section-blockはlpのdivそのものなので直接追加
    const lpSec = document.getElementById('lp-section');
    lpSec.insertAdjacentHTML('beforeend', infoHtml);
  } else if (lp.isHeuristic) {
    const noteHtml = `
      <div style="margin-top:14px;padding:12px 16px;background:rgba(192,122,0,.06);border:1px solid rgba(192,122,0,.2);border-radius:8px;font-size:.8rem;color:#7a5800;">
        ⚠ URLへの直接アクセスができなかったため、URLパターンに基づく推定診断となっています。より正確な診断は「広告アカウント無料診断」でご確認いただけます。
      </div>
    `;
    document.getElementById('lp-section').insertAdjacentHTML('beforeend', noteHtml);
  }
}

function titleTypeLabel(t) {
  if (t === 'benefit') return '✓ ベネフィット型（良好）';
  if (t === 'feature') return '△ 機能説明型（改善余地あり）';
  if (t === 'brand')   return '⚠ ブランド型（CVRに影響）';
  return '不明';
}

/** ⑦ 改善ポイント */
function renderImprovements(d) {
  document.getElementById('improvements-list').innerHTML =
    d.improvements.map(item => `
      <div class="improvement-item ${item.severity}">
        <div class="imp-icon">${item.icon}</div>
        <div class="imp-content">
          <div class="imp-badge">${item.badge}</div>
          <div class="imp-title">${item.title}</div>
          <div class="imp-body">${item.body}</div>
        </div>
      </div>
    `).join('');
}

/** ⑧ CTAパーソナライゼーション */
function renderCTA(d) {
  const annualStr = `¥${fmtNum(d.annualSavings)}`;
  if (d.annualSavings > 0) {
    document.getElementById('mcta-title').innerHTML =
      `年間 <span class="highlight">${annualStr}</span> の<br>広告費ムダを取り戻せます`;
    document.getElementById('mcta-sub').textContent =
      `広告アカウントを無料診断し、どこでムダが発生しているかを具体的にお伝えします。CPA ${d.improvePotential}% 改善で年間${annualStr}の回収が見込めます。`;
  }
}

// ═══════════════════════════════════════════════════════════
// 9. リード獲得
// ═══════════════════════════════════════════════════════════

function scrollToLead() {
  document.getElementById('lead-form').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

/**
 * リードフォームの送信処理
 */
function submitLead() {
  const email   = document.getElementById('lf-email').value.trim();
  const company = document.getElementById('lf-company').value.trim();
  const errEl   = document.getElementById('lf-error');

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    errEl.textContent = '正しいメールアドレスを入力してください';
    errEl.style.display = 'block';
    return;
  }
  errEl.style.display = 'none';

  // 送信中アニメーション
  const btn = document.getElementById('btn-lf-submit');
  btn.disabled = true;
  btn.innerHTML = `
    <span style="display:inline-block;width:14px;height:14px;border:2px solid rgba(255,255,255,.4);border-top-color:#fff;border-radius:50%;animation:spin .6s linear infinite;"></span>
    送信中...
  `;

  // 実際の送信処理（要バックエンド連携）
  setTimeout(() => {
    const formBlock = document.getElementById('lead-form');
    formBlock.innerHTML = `
      <div style="padding:48px;text-align:center;width:100%;">
        <div style="font-size:2rem;margin-bottom:14px;">✅</div>
        <div style="font-family:'Syne',sans-serif;font-size:1.2rem;font-weight:800;color:#0c0f16;margin-bottom:8px;">
          ありがとうございます！
        </div>
        <div style="font-size:.9rem;color:#8a8680;line-height:1.7;">
          <strong>${escHtml(email)}</strong> にPDFレポートをお送りします。<br>
          ${company ? `${escHtml(company)} 様、` : ''}この後、担当者よりご連絡させていただく場合があります。
        </div>
      </div>
    `;
  }, 1200);
}

// ═══════════════════════════════════════════════════════════
// 10. リセット
// ═══════════════════════════════════════════════════════════

function retryDiagnosis() {
  // チャートを全て破棄
  Object.keys(chartInstances).forEach(destroyChart);
  diagnosisData = null;

  // フォームをリセット
  document.getElementById('input-url').value  = '';
  document.getElementById('input-spend').value = '';
  document.getElementById('input-cv').value    = '';
  document.querySelectorAll('input[name="media"]').forEach(cb => {
    cb.checked = false;
    cb.closest('.media-tile')?.classList.remove('selected');
  });

  // UIリセット
  document.getElementById('results-section').style.display  = 'none';
  document.getElementById('loading-section').style.display  = 'none';
  document.getElementById('form-section').style.display     = 'block';
  document.getElementById('sticky-cta').style.display       = 'none';
  document.getElementById('url-status').textContent         = '';

  // ローディングステップリセット
  ['ls-1','ls-2','ls-3','ls-4','ls-5'].forEach(id => {
    const el = document.getElementById(id);
    if (el) { el.className = 'loading-step'; el.querySelector('.ls-status').textContent = ''; }
  });

  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ═══════════════════════════════════════════════════════════
// 11. ユーティリティ
// ═══════════════════════════════════════════════════════════

/** チャートを安全に破棄する */
function destroyChart(key) {
  if (chartInstances[key]) {
    chartInstances[key].destroy();
    delete chartInstances[key];
  }
}

/** 数値を3桁カンマ区切りに */
function fmtNum(n) {
  return Math.round(n).toLocaleString('ja-JP');
}

/** HTMLエスケープ */
function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** ms待機するPromise */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
