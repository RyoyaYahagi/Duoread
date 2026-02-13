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
        '[translate="no"]'
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
            const text = getDirectText(el).trim();
            if (!text || text.length < 2) continue;

            // 日本語が大半のテキストはスキップ（既に日本語）
            if (isMainlyJapanese(text)) continue;

            targets.push(el);
        }

        return targets;
    }

    /**
     * 要素の直接テキストを取得（子要素のテキストも含む）
     */
    function getDirectText(element) {
        return element.innerText || element.textContent || '';
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
                const texts = batch.map(el => getDirectText(el).trim());

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
                            insertTranslation(el, response.translated[index]);
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
     */
    function insertTranslation(originalElement, translatedText) {
        // 既存の翻訳要素を削除
        const existing = originalElement.nextElementSibling;
        if (existing && existing.classList.contains(TRANSLATE_CLASS)) {
            existing.remove();
        }

        // 翻訳文の要素を作成
        const translationEl = document.createElement(originalElement.tagName);
        translationEl.className = TRANSLATE_CLASS;
        translationEl.setAttribute(SOURCE_ATTR, 'google');
        translationEl.textContent = translatedText;

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
})();
