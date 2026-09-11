import { useEffect, useRef, useState } from 'react';
import { Eye, EyeOff, Trash2, Download, Upload, AlertTriangle } from 'lucide-react';
import { Card, Button, ErrorAlert, InlineNotice } from '../components/ui.jsx';
import { useSettings } from '../hooks/useSettings.js';
import { MODELS, testApiConnection } from '../lib/api.js';
import {
  exportBackup,
  importBackup,
  validateBackup,
  clearAllPaperData,
  deleteSetting,
  getUsageSummary,
  isStoragePersisted,
} from '../lib/storage.js';
import { downloadJson } from '../lib/export.js';

export function SettingsPage() {
  const { settings, update, reload } = useSettings();
  const [showKey, setShowKey] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [testing, setTesting] = useState(false);
  const [usage, setUsage] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [persisted, setPersisted] = useState(null);
  const importInputRef = useRef(null);

  useEffect(() => {
    getUsageSummary().then(setUsage);
    isStoragePersisted().then(setPersisted);
  }, []);

  if (!settings) return null;

  const modelId = settings.model || 'claude-sonnet-5';
  const effectiveModel = modelId === 'custom' ? settings.customModel || '' : modelId;

  async function handleTest() {
    setTesting(true);
    setTestResult(null);
    const result = await testApiConnection(settings.apiKey, effectiveModel);
    setTestResult(result);
    setTesting(false);
  }

  async function handleDeleteKey() {
    if (!confirm('確定要刪除已儲存的 API key 嗎？')) return;
    await deleteSetting('apiKey');
    await update('apiKey', '');
    setTestResult(null);
  }

  async function handleDownloadBackup() {
    const backup = await exportBackup();
    downloadJson(`paperlens-backup-${new Date().toISOString().slice(0, 10)}.json`, backup);
    setNotice('備份已下載（不含 API key 與 PDF 原始檔）。');
  }

  async function handleImportFile(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setError('');
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      const { valid, errors } = validateBackup(data);
      if (!valid) {
        setError(`備份檔格式錯誤：${errors.join('、')}`);
        return;
      }
      const paperCount = data.papers?.length ?? 0;
      if (!confirm(`即將匯入備份（${paperCount} 篇論文的分析資料）。相同 ID 的資料會被覆蓋，是否繼續？\n\n注意：備份不含 PDF 原始檔，匯入的論文需要重新上傳 PDF 才能開啟原文核對。`)) {
        return;
      }
      await importBackup(data);
      await reload();
      setNotice('備份匯入完成。');
    } catch (err) {
      setError(`匯入失敗：${err.message || err}`);
    }
  }

  async function handleClearAll() {
    if (!confirm('確定要清除所有論文與分析資料嗎？此操作無法復原。（API key、模型設定、研究背景將會保留）')) return;
    await clearAllPaperData();
    setUsage(await getUsageSummary());
    setNotice('已清除所有論文與分析資料。');
  }

  return (
    <div>
      <div className="page-header">
        <h1>設定</h1>
        <p>API key、模型、研究背景、備份與資料管理。</p>
      </div>

      <div className="alert alert-warning mb-2">
        <AlertTriangle size={16} style={{ marginTop: 2, flexShrink: 0 }} />
        <div>
          PaperLens 的論文、分析與設定目前只儲存在這個瀏覽器的本機資料庫。清除瀏覽器網站資料、切換瀏覽器或使用不同網址可能使資料無法存取。重要資料請定期匯出備份。
          {persisted === false && (
            <p className="mt-1" style={{ marginBottom: 0, fontSize: 13 }}>
              目前這個瀏覽器尚未授予「持久性儲存」，在裝置儲存空間不足時，資料有較高機率被瀏覽器自動清除。
            </p>
          )}
        </div>
      </div>

      <ErrorAlert message={error} onDismiss={() => setError('')} />
      <InlineNotice kind="success" message={notice} />

      <Card>
        <h3 className="mt-0">Claude API key</h3>
        <div className="alert alert-warning mb-2">
          <AlertTriangle size={16} style={{ marginTop: 2, flexShrink: 0 }} />
          <div>
            API key 僅儲存在目前瀏覽器（IndexedDB），不會寫入 GitHub 或備份檔。但這是純前端網站，頁面上的
            JavaScript 能夠使用這把 key，因此請只在你信任的程式碼與裝置上使用，不要在公用電腦上長期保存。
          </div>
        </div>
        <div className="field">
          <label htmlFor="apiKey">API key</label>
          <div className="input-with-action">
            <input
              id="apiKey"
              className="input"
              type={showKey ? 'text' : 'password'}
              autoComplete="off"
              value={settings.apiKey || ''}
              onChange={(e) => update('apiKey', e.target.value)}
              placeholder="sk-ant-..."
            />
            <Button type="button" onClick={() => setShowKey((v) => !v)} aria-label={showKey ? '隱藏' : '顯示'}>
              {showKey ? <EyeOff size={16} /> : <Eye size={16} />}
            </Button>
            <Button type="button" variant="danger" onClick={handleDeleteKey}>
              <Trash2 size={14} />
              刪除
            </Button>
          </div>
        </div>

        <div className="field">
          <label htmlFor="model">模型</label>
          <select id="model" className="select" value={modelId} onChange={(e) => update('model', e.target.value)}>
            {MODELS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </div>

        {modelId === 'custom' && (
          <div className="field">
            <label htmlFor="customModel">自訂 model ID</label>
            <input
              id="customModel"
              className="input"
              value={settings.customModel || ''}
              onChange={(e) => update('customModel', e.target.value)}
              placeholder="例如：claude-sonnet-5-20260101"
            />
          </div>
        )}

        <Button variant="primary" onClick={handleTest} disabled={testing}>
          {testing ? '測試中...' : '測試 API 連線'}
        </Button>

        {testResult && (
          <div className="mt-2">
            <InlineNotice kind={testResult.success ? 'success' : 'danger'} message={testResult.message} />
          </div>
        )}
      </Card>

      <Card>
        <h3 className="mt-0">我的研究背景</h3>
        <p className="muted" style={{ fontSize: 13 }}>
          會附加在每次分析請求中，僅影響 Claude 判斷「哪些內容值得特別指出」與「用什麼角度解釋」，不會改變論文本身的事實內容。可以留空。
        </p>
        <textarea
          className="textarea"
          rows={5}
          value={settings.researchBackground || ''}
          onChange={(e) => update('researchBackground', e.target.value)}
          placeholder="例如：我在研究資料中心網路的壅塞控制，特別關注高負載下的延遲與公平性。"
        />
      </Card>

      <Card>
        <h3 className="mt-0">用量統計</h3>
        {usage ? (
          <table className="simple-table">
            <tbody>
              <tr>
                <th>請求次數</th>
                <td>{usage.requestCount}</td>
              </tr>
              <tr>
                <th>Input tokens</th>
                <td>{usage.inputTokens.toLocaleString()}</td>
              </tr>
              <tr>
                <th>Output tokens</th>
                <td>{usage.outputTokens.toLocaleString()}</td>
              </tr>
              {usage.hasCacheData && (
                <>
                  <tr>
                    <th>Cache creation tokens</th>
                    <td>{usage.cacheCreationTokens.toLocaleString()}</td>
                  </tr>
                  <tr>
                    <th>Cache read tokens</th>
                    <td>{usage.cacheReadTokens.toLocaleString()}</td>
                  </tr>
                </>
              )}
            </tbody>
          </table>
        ) : (
          <p className="muted">載入中...</p>
        )}
      </Card>

      <Card>
        <h3 className="mt-0">備份與還原</h3>
        <p className="muted" style={{ fontSize: 13 }}>
          備份包含論文的擷取文字、分析結果、提問紀錄、比較結果與研究背景，<strong>不含</strong> API key 與 PDF 原始檔。
        </p>
        <div className="row">
          <Button onClick={handleDownloadBackup}>
            <Download size={14} />
            下載備份
          </Button>
          <Button onClick={() => importInputRef.current?.click()}>
            <Upload size={14} />
            匯入備份
          </Button>
          <input
            ref={importInputRef}
            type="file"
            accept="application/json"
            style={{ display: 'none' }}
            onChange={handleImportFile}
          />
        </div>
      </Card>

      <Card>
        <h3 className="mt-0">清除資料</h3>
        <p className="muted" style={{ fontSize: 13 }}>
          清除所有論文、PDF、分析結果、提問紀錄、比較結果與用量統計。API key、模型設定與研究背景會保留。
        </p>
        <Button variant="danger" onClick={handleClearAll}>
          <Trash2 size={14} />
          清除所有論文與分析
        </Button>
      </Card>
    </div>
  );
}
