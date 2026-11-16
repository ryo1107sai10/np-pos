import { deviceLockIntervals } from './device-lock.mjs';

const pinInput = (name, label, required = false) => `<label class="field"><span>${label}</span>
  <input type="password" name="${name}" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="off"${required ? ' required' : ''}></label>`;

export function renderDeviceLockSettings({ enabled, minutes }, sample) {
  const intervals = deviceLockIntervals.map((value) => `<option value="${value}"${value === minutes ? ' selected' : ''}>${value}分</option>`).join('');
  return `<div class="device-lock-settings">
    <p class="form-copy">${sample ? 'デモ用の画面ロックです。このタブを再読み込みすると設定がリセットされます。'
      : 'このブラウザーの画面をロックします。同じブラウザーのタブでロック状態を共有します。'}</p>
    <label class="field"><span>画面ロック</span><select name="deviceLockEnabled" required>
      <option value="on"${enabled ? ' selected' : ''}>オン</option><option value="off"${enabled ? '' : ' selected'}>オフ</option>
    </select></label>
    <label class="field"><span>操作がない場合にロックするまで</span><select name="deviceLockMinutes" required>${intervals}</select></label>
    ${enabled ? pinInput('deviceCurrentPin', '現在のPIN', true) : ''}
    ${pinInput('deviceNewPin', enabled ? '新しいPIN（変更する場合）' : 'PIN（半角数字6桁）')}
    ${pinInput('deviceConfirmPin', '新しいPINをもう一度入力')}
  </div>`;
}

export function renderDeviceLockScreen({ sample, providers }) {
  return `<main class="device-lock-card" aria-labelledby="device-lock-title">
    <img src="np-pos.svg" width="46" height="46" alt="NP POS">
    <div><h1 id="device-lock-title">画面をロックしました</h1><p>操作を再開するには、6桁のPINを入力してください。</p></div>
    <form id="device-pin-form">
      ${pinInput('pin', '画面ロック用PIN', true)}
      <button type="submit" class="btn btn-primary">ロックを解除</button>
    </form>
    <p class="device-lock-message" data-lock-wait hidden></p>
    <p class="device-lock-error" data-lock-error role="alert" hidden></p>
    ${sample ? '<p class="device-lock-hint">デモモードです。PINを忘れた場合は、ページの再読み込みで解除できます。</p>'
      : `<details class="device-lock-recovery"><summary>PINを忘れた場合</summary>
        <p>アカウントで本人確認すると、この端末のPINをリセットできます。</p>
        ${providers.includes('email') ? `<form id="device-recovery-form">
          <label class="field"><span>メールアドレス</span><input name="email" type="email" autocomplete="username" required></label>
          <label class="field"><span>アカウントのパスワード</span><input name="password" type="password" autocomplete="current-password" required></label>
          <button type="submit" class="btn btn-secondary">本人確認してPINをリセット</button>
        </form>` : ''}
        ${providers.includes('google') ? '<button type="button" class="btn btn-secondary" data-device-google>Googleで本人確認</button>' : ''}
      </details>`}
  </main>`;
}

export function updateDeviceLockScreen(screen, { retryAt }, busy, message) {
  const seconds = Math.max(0, Math.ceil((retryAt - Date.now()) / 1_000));
  const wait = screen.querySelector('[data-lock-wait]');
  const text = seconds ? `あと${seconds}秒でPINを入力できます。` : '';
  if (wait.textContent !== text) wait.textContent = text;
  wait.hidden = seconds === 0;
  const error = screen.querySelector('[data-lock-error]');
  if (error.textContent !== message) error.textContent = message;
  error.hidden = !message;
  for (const button of screen.querySelectorAll('button')) button.disabled = busy || (button.form?.id === 'device-pin-form' && seconds > 0);
}
