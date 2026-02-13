/**
 * 没入型翻訳 - Service Worker (background.js)
 * Google翻訳APIとの通信、メッセージングハブ
 */

// --- 翻訳キャッシュ & API ---

/**
 * テキストのSHA-256ハッシュを生成（キャッシュキー用）
 */
async function getHash(text) {
  const msgBuffer = new TextEncoder().encode(text);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * テキスト配列を翻訳（キャッシュ優先）
 */
async function translateTexts(texts, sourceLang = 'en', targetLang = 'ja') {
  const cacheKey = `tr_cache_${sourceLang}_${targetLang}`;
  const cacheResult = await chrome.storage.local.get([cacheKey]);
  const cache = cacheResult[cacheKey] || {};

  const results = new Array(texts.length).fill(null);
  const uncachedIndices = [];
  const uncachedTexts = [];

  // キャッシュ確認
  for (let i = 0; i < texts.length; i++) {
    const text = texts[i];
    const hash = await getHash(text);

    if (cache[hash]) {
      results[i] = cache[hash];
    } else {
      uncachedIndices.push(i);
      uncachedTexts.push(text);
    }
  }

  // 全てキャッシュにある場合
  if (uncachedTexts.length === 0) {
    return results;
  }

  // 未キャッシュ分をAPIリクエスト
  try {
    const apiResults = await fetchTranslationsFromApi(uncachedTexts, sourceLang, targetLang);

    // 結果を統合 & キャッシュ更新
    const newCache = {};
    for (let i = 0; i < uncachedTexts.length; i++) {
      const originalIndex = uncachedIndices[i];
      const translated = apiResults[i];
      const text = uncachedTexts[i];
      const hash = await getHash(text);

      results[originalIndex] = translated;
      newCache[hash] = translated;
    }

    // キャッシュ保存（非同期）
    chrome.storage.local.set({
      [cacheKey]: { ...cache, ...newCache }
    });

  } catch (error) {
    console.error('翻訳APIエラー:', error);
    // エラー時はキャッシュ値のみ返す（未翻訳分はnull）
    // またはエラーをスローして呼び出し元に通知
    throw error;
  }

  return results;
}

/**
 * Google翻訳APIを実行（バッチ処理・リトライ付き）
 */
async function fetchTranslationsFromApi(texts, sourceLang, targetLang) {
  const results = [];
  const batchSize = 10; // 1リクエストあたりの最大テキスト数

  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const batchResults = await translateBatch(batch, sourceLang, targetLang);
    // 単一の文字列が返された場合（batchサイズ1の時など）の対応
    if (Array.isArray(batchResults)) {
      results.push(...batchResults);
    } else {
      results.push(batchResults);
    }

    // レート制限対策: バッチ間にディレイ
    if (i + batchSize < texts.length) {
      await delay(200);
    }
  }

  return results;
}

/**
 * バッチ単位でGoogle翻訳APIにリクエスト
 */
async function translateBatch(texts, sourceLang, targetLang) {
  const url = new URL('https://translate.googleapis.com/translate_a/t');
  url.searchParams.set('client', 'gtx');
  url.searchParams.set('sl', sourceLang);
  url.searchParams.set('tl', targetLang);
  url.searchParams.set('dt', 't');

  // 複数テキストをクエリパラメータとして追加
  const params = new URLSearchParams();
  params.set('client', 'gtx');
  params.set('sl', sourceLang);
  params.set('tl', targetLang);
  params.set('dt', 't');
  texts.forEach(text => params.append('q', text));

  const maxRetries = 3;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const response = await fetch(
        `https://translate.googleapis.com/translate_a/t?${params.toString()}`
      );

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();

      // レスポンス形式の正規化
      // 単一テキストの場合: [翻訳文] or 翻訳文
      // 複数テキストの場合: [[翻訳文1], [翻訳文2], ...]
      if (texts.length === 1) {
        if (Array.isArray(data)) {
          return [Array.isArray(data[0]) ? data[0][0] : data[0]];
        }
        return [String(data)];
      }

      return data.map(item => {
        if (Array.isArray(item)) return item[0];
        return String(item);
      });
    } catch (error) {
      console.error(`翻訳リクエスト失敗 (試行 ${attempt + 1}/${maxRetries}):`, error);
      if (attempt < maxRetries - 1) {
        await delay(Math.pow(2, attempt) * 500); // 指数バックオフ
      } else {
        throw error;
      }
    }
  }
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// --- メッセージングハブ ---

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'TRANSLATE') {
    handleTranslateRequest(message, sender)
      .then(sendResponse)
      .catch(error => sendResponse({ error: error.message }));
    return true; // 非同期レスポンス
  }

  if (message.type === 'GET_STATE') {
    chrome.storage.local.get(['isTranslating'], (result) => {
      sendResponse({ isTranslating: result.isTranslating || false });
    });
    return true;
  }
});

/**
 * Content Scriptからの翻訳リクエストを処理
 */
async function handleTranslateRequest(message) {
  const { texts, sourceLang, targetLang } = message;

  try {
    const translated = await translateTexts(texts, sourceLang, targetLang);
    return { translated };
  } catch (error) {
    return { error: error.message };
  }
}

// --- ショートカットキー ---

chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'toggle-translate') {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) {
      chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_TRANSLATE' });
    }
  }
});

// --- インストール時の初期化 ---

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    chrome.storage.local.set({
      sourceLang: 'en',
      targetLang: 'ja',
    });
  }
});
