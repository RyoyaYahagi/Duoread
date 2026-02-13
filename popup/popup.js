/**
 * 没入型翻訳 - Popup Script (popup.js)
 * Popup UIのインタラクション管理
 */

document.addEventListener('DOMContentLoaded', async () => {
    const translateBtn = document.getElementById('translate-btn');
    const btnIcon = document.getElementById('btn-icon');
    const btnText = document.getElementById('btn-text');
    const statusEl = document.getElementById('status');

    // 現在のタブの翻訳状態を取得
    let isTranslated = false;

    try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab?.id) {
            const response = await chrome.tabs.sendMessage(tab.id, { type: 'GET_STATUS' });
            isTranslated = response?.isTranslated || false;
            updateUI(isTranslated, response?.isTranslating);
        }
    } catch (e) {
        // Content Script がまだロードされていない場合
        showStatus('このページでは翻訳できません', 'error');
        translateBtn.disabled = true;
    }

    // 翻訳ボタンクリック
    translateBtn.addEventListener('click', async () => {
        translateBtn.disabled = true;

        try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (!tab?.id) return;

            if (isTranslated) {
                // 翻訳解除
                await chrome.tabs.sendMessage(tab.id, { type: 'STOP_TRANSLATE' });
                isTranslated = false;
                updateUI(false);
                showStatus('翻訳を解除しました', 'success');
            } else {
                // 翻訳開始
                updateUI(false, true);
                showStatus('翻訳中...', 'loading');
                const response = await chrome.tabs.sendMessage(tab.id, { type: 'START_TRANSLATE' });
                isTranslated = response?.isTranslated || false;
                updateUI(isTranslated);
                showStatus(isTranslated ? '翻訳完了 ✓' : '翻訳対象がありません', 'success');
            }
        } catch (error) {
            showStatus(`エラー: ${error.message}`, 'error');
        } finally {
            translateBtn.disabled = false;
        }
    });

    /**
     * UIの状態を更新
     */
    function updateUI(translated, translating = false) {
        if (translating) {
            btnIcon.textContent = '⏳';
            btnText.textContent = '翻訳中...';
            translateBtn.classList.add('translating');
            translateBtn.classList.remove('active');
        } else if (translated) {
            btnIcon.textContent = '✓';
            btnText.textContent = '翻訳を解除';
            translateBtn.classList.add('active');
            translateBtn.classList.remove('translating');
        } else {
            btnIcon.textContent = '🌐';
            btnText.textContent = 'このページを翻訳';
            translateBtn.classList.remove('active', 'translating');
        }
    }

    /**
     * ステータスメッセージを表示
     */
    function showStatus(message, type = 'info') {
        statusEl.textContent = message;
        statusEl.className = `status ${type}`;
        statusEl.style.display = 'block';

        if (type !== 'loading') {
            setTimeout(() => {
                statusEl.style.display = 'none';
            }, 3000);
        }
    }

    // --- 設定画面ロジック ---

    const settingsBtn = document.getElementById('settings-btn');
    const backBtn = document.getElementById('back-btn');
    const settingsView = document.getElementById('settings-view');
    const engineSelect = document.getElementById('engine-select');
    const geminiKeyContainer = document.getElementById('gemini-key-container');
    const geminiApiKeyInput = document.getElementById('gemini-api-key');
    const saveSettingsBtn = document.getElementById('save-settings-btn');
    const settingsStatus = document.getElementById('settings-status');

    // 設定画面を開く
    settingsBtn.addEventListener('click', async () => {
        // 設定を読み込む
        const { translationEngine, geminiApiKey } = await chrome.storage.sync.get(['translationEngine', 'geminiApiKey']);

        engineSelect.value = translationEngine || 'google';
        geminiApiKeyInput.value = geminiApiKey || '';

        updateGeminiKeyVisibility();
        settingsView.style.display = 'block';
    });

    // 設定画面を閉じる
    backBtn.addEventListener('click', () => {
        settingsView.style.display = 'none';
        settingsStatus.textContent = '';
    });

    // エンジン選択変更時
    engineSelect.addEventListener('change', updateGeminiKeyVisibility);

    function updateGeminiKeyVisibility() {
        if (engineSelect.value === 'gemini') {
            geminiKeyContainer.style.display = 'block';
        } else {
            geminiKeyContainer.style.display = 'none';
        }
    }

    // 設定を保存
    saveSettingsBtn.addEventListener('click', () => {
        const engine = engineSelect.value;
        const key = geminiApiKeyInput.value.trim();

        if (engine === 'gemini' && !key) {
            showSettingsStatus('APIキーを入力してください', 'red');
            return;
        }

        chrome.storage.sync.set({
            translationEngine: engine,
            geminiApiKey: key
        }, () => {
            showSettingsStatus('設定を保存しました', 'green');
            setTimeout(() => {
                settingsView.style.display = 'none';
                popupContainer.style.display = 'block';
                settingsStatus.textContent = '';
            }, 1000);
        });
    });

    function showSettingsStatus(msg, color) {
        settingsStatus.textContent = msg;
        settingsStatus.style.color = color;
    }
});
