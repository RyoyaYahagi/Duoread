/**
 * 没入型翻訳 - Content Script (content.js)
 * ページのテキスト抽出・翻訳文挿入を担当
 */

(() => {
    'use strict';

    // --- 定数 ---
    const TRANSLATE_CLASS = 'immersive-translate-result';
    const TRANSLATE_WRAPPER_CLASS = 'immersive-translate-wrapper';
    const TRANSLATING_CLASS = 'immersive-translate-loading';
    const TRANSLATED_ATTR = 'data-immersive-translated';
    const SOURCE_ATTR = 'data-source';

    // 翻訳対象のブロック要素セレクタ
    const TARGET_SELECTORS = [
        'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
        'li', 'td', 'th', 'blockquote', 'caption',
        'dd', 'dt', 'figcaption', 'summary'
    ].join(',');

    // 除外する要素のセレクタ
    const EXCLUDE_SELECTORS = [
        'code', 'pre', 'script', 'style', 'noscript',
        'input', 'textarea', 'select', 'button',
        'nav', 'footer', 'header',
        '.immersive-translate-result',
        '.immersive-translate-wrapper',
        '[contenteditable="true"]',
        '[translate="no"]',
        '.MathJax', '.jax', '.math', '.katex', '.mjx-chtml', // 数式除外
        'table' // 表を除外
    ].join(',');

    let isTranslated = false;
    let isTranslating = false;

    // --- 翻訳対象要素の収集 ---

    /**
     * ページから翻訳対象のブロック要素を収集
     * @returns {Element[]}
     */
    function collectTargetElements() {
        const allElements = document.querySelectorAll(TARGET_SELECTORS);
        const targets = [];

        for (const el of allElements) {
            // 既に翻訳済みの要素はスキップ
            if (el.hasAttribute(TRANSLATED_ATTR)) continue;

            // 除外要素の中にある場合はスキップ
            if (el.closest(EXCLUDE_SELECTORS)) continue;

            // テキストが空または短すぎる場合はスキップ
            const { text } = getTranslatableText(el);
            if (!text || text.length < 2) continue;

            // 日本語が大半のテキストはスキップ（既に日本語）
            if (isMainlyJapanese(text)) continue;

            targets.push(el);
        }

        return targets;
    }

    /**
     * 翻訳対象テキストとプレースホルダーマップを取得
     * @returns {{text: string, placeholderMap: Object}}
     */
    function getTranslatableText(element) {
        // クローンを作成して処理（元のDOMを破壊しないため）
        const clone = element.cloneNode(true);
        const placeholderMap = {};
        let placeholderIndex = 0;

        // 数式要素を特定してプレースホルダーに置換
        const mathSelectors = [
            '.MathJax', '.jax', '.math', '.katex', '.mjx-chtml',
            'script[type^="math/"]', 'math'
        ].join(',');

        const mathElements = clone.querySelectorAll(mathSelectors);
        mathElements.forEach(el => {
            // 一意なIDを生成（例: __MATH_0__）
            const id = `__MATH_${placeholderIndex++}__`;
            placeholderMap[id] = el.outerHTML; // 元のHTMLを保持
            el.textContent = ` ${id} `;
        });

        // コードブロックなども置換（念のため）
        const codeElements = clone.querySelectorAll('code, pre');
        codeElements.forEach(el => {
            const id = `__CODE_${placeholderIndex++}__`;
            placeholderMap[id] = el.outerHTML;
            el.textContent = ` ${id} `;
        });

        // 改行を空白に置換して1行にする
        const text = (clone.innerText || clone.textContent || '')
            .replace(/\s+/g, ' ')
            .trim();

        return { text, placeholderMap };
    }

    /**
     * プレースホルダーを含む翻訳文をHTMLに復元
     */
    function restorePlaceholders(translatedText, placeholderMap) {
        if (!translatedText) return '';
        let html = escapeHtml(translatedText);

        // プレースホルダーを置換
        for (const [id, originalHtml] of Object.entries(placeholderMap)) {
            // 翻訳過程でスペースが入ったり全角になったりする場合に対応
            // __MATH_0__ -> __MATH_ 0 __, ＿MATH_0＿ 等の揺らぎを吸収
            const escapedId = id.replace(/_/g, '[_＿]');
            const pattern = new RegExp(escapedId.split('').join('\\s*'), 'gi');

            // 復元（HTMLとして挿入するため安全性を確認済みとする）
            // ※originalHtmlはDOMから取得したものなので基本的には安全だが
            // 念のため信頼済みソースとして扱う
            html = html.replace(pattern, `<span class="immersive-translate-placeholder">${originalHtml}</span>`);
        }

        return html;
    }

    /**
     * HTMLエスケープ処理
     */
    function escapeHtml(text) {
        return text
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    }

    /**
     * テキストが主に日本語かどうかを判定
     */
    function isMainlyJapanese(text) {
        const japanesePattern = /[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF]/g;
        const matches = text.match(japanesePattern);
        if (!matches) return false;
        return matches.length / text.length > 0.3;
    }

    // --- 翻訳処理 ---

    /**
     * ページ全体の翻訳を実行
     */
    async function translatePage() {
        if (isTranslating) return;
        isTranslating = true;

        try {
            const targets = collectTargetElements();
            if (targets.length === 0) {
                isTranslating = false;
                return;
            }

            // バッチに分割して翻訳
            const batchSize = 20;
            for (let i = 0; i < targets.length; i += batchSize) {
                const batch = targets.slice(i, i + batchSize);
                // 各要素のテキストとプレースホルダーマップを取得
                const batchData = batch.map(el => getTranslatableText(el));
                const texts = batchData.map(d => d.text);

                // ローディング表示
                batch.forEach(el => {
                    el.setAttribute(TRANSLATED_ATTR, 'loading');
                    showLoadingIndicator(el);
                });

                try {
                    // Service Worker に翻訳リクエスト
                    const response = await chrome.runtime.sendMessage({
                        type: 'TRANSLATE',
                        texts: texts,
                        sourceLang: 'en',
                        targetLang: 'ja'
                    });

                    if (response.error) {
                        console.error('翻訳エラー:', response.error);
                        batch.forEach(el => {
                            removeLoadingIndicator(el);
                            el.removeAttribute(TRANSLATED_ATTR);
                        });
                        continue;
                    }

                    // 翻訳結果を挿入
                    batch.forEach((el, index) => {
                        removeLoadingIndicator(el);
                        if (response.translated[index]) {
                            // プレースホルダーを復元して挿入
                            const translatedHtml = restorePlaceholders(
                                response.translated[index],
                                batchData[index].placeholderMap
                            );
                            insertTranslation(el, translatedHtml, true); // HTMLとして挿入
                            el.setAttribute(TRANSLATED_ATTR, 'done');
                        }
                    });
                } catch (error) {
                    console.error('翻訳バッチエラー:', error);
                    batch.forEach(el => {
                        removeLoadingIndicator(el);
                        el.removeAttribute(TRANSLATED_ATTR);
                    });
                }
            }

            isTranslated = true;
        } finally {
            isTranslating = false;
        }
    }

    /**
     * 翻訳文を元の要素の直下に挿入
     * @param {HTMLElement} originalElement - 原文要素
     * @param {string} content - 翻訳文（テキストまたはHTML）
     * @param {boolean} isHtml - contentがHTMLかどうか
     */
    function insertTranslation(originalElement, content, isHtml = false) {
        // 既存の翻訳要素を削除
        const existing = originalElement.nextElementSibling;
        if (existing && existing.classList.contains(TRANSLATE_CLASS)) {
            existing.remove();
        }

        // 翻訳文の要素を作成
        const translationEl = document.createElement(originalElement.tagName);
        translationEl.className = TRANSLATE_CLASS;
        translationEl.setAttribute(SOURCE_ATTR, 'google');

        if (isHtml) {
            translationEl.innerHTML = content;
        } else {
            translationEl.textContent = content;
        }

        // 原文要素の直後に挿入
        originalElement.after(translationEl);
    }

    /**
     * ローディングインジケータを表示
     */
    function showLoadingIndicator(element) {
        const existing = element.nextElementSibling;
        if (existing && existing.classList.contains(TRANSLATING_CLASS)) return;

        const loader = document.createElement('div');
        loader.className = TRANSLATING_CLASS;
        loader.textContent = '翻訳中...';
        element.after(loader);
    }

    /**
     * ローディングインジケータを削除
     */
    function removeLoadingIndicator(element) {
        const next = element.nextElementSibling;
        if (next && next.classList.contains(TRANSLATING_CLASS)) {
            next.remove();
        }
    }

    // --- 翻訳解除 ---

    /**
     * すべての翻訳文を削除
     */
    function removeAllTranslations() {
        // 翻訳文要素を削除
        document.querySelectorAll(`.${TRANSLATE_CLASS}`).forEach(el => el.remove());
        // ローディング要素を削除
        document.querySelectorAll(`.${TRANSLATING_CLASS}`).forEach(el => el.remove());
        // 翻訳済み属性を解除
        document.querySelectorAll(`[${TRANSLATED_ATTR}]`).forEach(el => {
            el.removeAttribute(TRANSLATED_ATTR);
        });
        isTranslated = false;
    }

    // --- トグル ---

    /**
     * 翻訳のON/OFFをトグル
     */
    async function toggleTranslate() {
        if (isTranslated) {
            removeAllTranslations();
        } else {
            await translatePage();
        }
    }

    // --- メッセージリスナー ---

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message.type === 'TOGGLE_TRANSLATE') {
            toggleTranslate().then(() => {
                sendResponse({ isTranslated });
            });
            return true;
        }

        if (message.type === 'START_TRANSLATE') {
            translatePage().then(() => {
                sendResponse({ isTranslated: true });
            });
            return true;
        }

        if (message.type === 'STOP_TRANSLATE') {
            removeAllTranslations();
            sendResponse({ isTranslated: false });
            return false;
        }

        if (message.type === 'GET_STATUS') {
            sendResponse({ isTranslated, isTranslating });
            return false;
        }
    });

    // --- 選択テキスト翻訳 ---

    let popupBtn = null;
    let popupCard = null;

    document.addEventListener('mouseup', handleSelection);
    document.addEventListener('mousedown', (e) => {
        // ポップアップ以外をクリックしたら閉じる
        if (popupCard && !popupCard.contains(e.target) && e.target !== popupBtn) {
            removePopup();
        }
        // アイコン以外をクリックしたらアイコンも消す
        if (popupBtn && !popupBtn.contains(e.target)) {
            removePopupBtn();
        }
    });

    function handleSelection(e) {
        // 既存のポップアップがあれば処理しない（閉じる処理はmousedownで行う）
        if (popupCard && popupCard.contains(e.target)) return;

        setTimeout(() => {
            const selection = window.getSelection();
            const text = selection.toString().trim();

            if (!text || text.length < 2 || isMainlyJapanese(text)) {
                removePopupBtn();
                return;
            }

            // 選択範囲の座標を取得
            const range = selection.getRangeAt(0);
            const rect = range.getBoundingClientRect();

            // アイコンを表示
            showPopupBtn(rect.right, rect.bottom + window.scrollY, text);
        }, 10);
    }

    function showPopupBtn(x, y, text) {
        removePopupBtn();

        popupBtn = document.createElement('button');
        popupBtn.className = 'immersive-translate-popup-btn';
        popupBtn.innerHTML = `
      <svg viewBox="0 0 24 24">
        <path d="M12.87 15.07l-2.54-2.51.03-.03A17.52 17.52 0 0014.07 6H17V4h-7V2H8v2H1v2h11.17C11.5 7.92 10.44 9.75 9 11.35 8.07 10.32 7.3 9.19 6.69 8h-2c.73 1.63 1.73 3.17 2.98 4.56l-5.09 5.02L4 19l5-5 3.11 3.11.76-2.04M18.5 10h-2L12 22h2l1.12-3h4.75L21 22h2l-4.5-12m-2.62 7l1.62-4.33L19.12 17h-3.24z"/>
      </svg>
    `;

        // スタイル調整（絶対位置）
        popupBtn.style.left = `${x + 5}px`;
        popupBtn.style.top = `${y + 10}px`;

        popupBtn.addEventListener('mousedown', (e) => {
            e.stopPropagation(); // 選択解除を防ぐ
            translateSelection(text, x, y);
        });

        document.body.appendChild(popupBtn);
    }

    function removePopupBtn() {
        if (popupBtn) {
            popupBtn.remove();
            popupBtn = null;
        }
    }

    function removePopup() {
        if (popupCard) {
            popupCard.remove();
            popupCard = null;
        }
    }

    async function translateSelection(text, x, y) {
        removePopupBtn();

        // カードをローディング状態で表示
        popupCard = document.createElement('div');
        popupCard.className = 'immersive-translate-popup-card';
        popupCard.style.left = `${x}px`;
        popupCard.style.top = `${y + 10}px`;

        // 画面からはみ出さないように調整
        const viewportWidth = window.innerWidth;
        if (x + 320 > viewportWidth) {
            popupCard.style.left = `${viewportWidth - 330}px`;
        }

        const escapedText = escapeHtml(text);
        popupCard.innerHTML = `
      <div class="immersive-translate-card-header">
        <span>翻訳結果</span>
        <span class="immersive-translate-close-btn" style="cursor:pointer;">×</span>
      </div>
      <div class="immersive-translate-card-content">
        <div class="immersive-translate-original-text">${escapedText}</div>
        <div class="immersive-translate-translated-text immersive-translate-loading-text">
          <span>翻訳中...</span>
        </div>
      </div>
    `;

        popupCard.querySelector('.immersive-translate-close-btn').addEventListener('click', removePopup);
        document.body.appendChild(popupCard);

        try {
            const response = await chrome.runtime.sendMessage({
                type: 'TRANSLATE',
                texts: [text],
                sourceLang: 'auto', // 自動判定
                targetLang: 'ja'
            });

            if (response && response.translated && response.translated[0]) {
                const resultEl = popupCard.querySelector('.immersive-translate-translated-text');
                resultEl.textContent = response.translated[0];
                resultEl.classList.remove('immersive-translate-loading-text');
            } else {
                throw new Error('翻訳失敗');
            }
        } catch (error) {
            const resultEl = popupCard.querySelector('.immersive-translate-translated-text');
            resultEl.textContent = '翻訳エラーが発生しました';
            resultEl.style.color = 'red';
            resultEl.classList.remove('immersive-translate-loading-text');
        }
    }
})();
