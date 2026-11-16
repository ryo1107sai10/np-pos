import { getAvailableInitialSets } from './set-schedule.mjs';

function scheduleRow(rule, plans, { escape, yen }) {
  const { start = '', end = '', setId = '' } = rule;
  const unavailable = setId && !plans.some((plan) => plan.id === setId);
  const choices = plans.map((plan) => `<option value="${escape(plan.id)}"${plan.id === setId ? ' selected' : ''}>
    ${escape(plan.name)} · ${plan.duration}分 · ${yen(plan.price)}/人</option>`).join('');
  return `<fieldset class="choices" data-initial-set-rule>
    <legend>時間帯</legend>
    <div class="form-grid">
      <label class="field"><span>開始</span><input type="time" name="initialSetStart" value="${escape(start)}" required></label>
      <label class="field"><span>終了</span><input type="time" name="initialSetEnd" value="${escape(end)}" required></label>
    </div>
    <label class="field"><span>初回セット</span><select name="initialSetId" required>
      <option value=""${setId ? '' : ' selected'}>選択してください</option>
      ${unavailable ? `<option value="${escape(setId)}" selected>利用できないセット（${escape(setId)}）</option>` : ''}${choices}
    </select></label>
    ${unavailable ? '<p class="field-help">使用できるセットに変更するか、この時間帯を削除してください。</p>' : ''}
    <button class="btn btn-secondary" type="button" data-initial-set-remove>この時間帯を削除</button>
  </fieldset>`;
}

export function renderInitialSetSchedule(state, api) {
  const plans = getAvailableInitialSets(state);
  const rules = state.initialSetSchedule ?? [];
  return `<div data-initial-set-schedule>
    <p class="form-copy">来店時のセットを日本時間で提案します。来店登録画面で別のセットに変更できます。</p>
    <p class="field-help">日付をまたぐ場合は、22:00から翌03:00のように開始と終了を入力してください。</p>
    <p class="form-copy" data-initial-set-empty${rules.length ? ' hidden' : ''}>提案する時間帯が未設定です。</p>
    ${plans.length ? '' : '<p class="field-help">店舗設定で利用できる初回セットを登録してください。</p>'}
    <div data-initial-set-rules>${rules.map((rule) => scheduleRow(rule, plans, api)).join('')}</div>
    <div class="ops-actions"><button class="btn btn-secondary" type="button" data-initial-set-add${plans.length ? '' : ' disabled'}>時間帯を追加</button></div>
    <template data-initial-set-template>${scheduleRow({}, plans, api)}</template>
  </div>`;
}

export function handleInitialSetScheduleClick(event) {
  const button = event.target?.closest?.('[data-initial-set-add], [data-initial-set-remove]');
  if (!button) return false;
  const editor = button.closest('[data-initial-set-schedule]');
  const rules = editor.querySelector('[data-initial-set-rules]');
  if (button.hasAttribute('data-initial-set-add')) {
    const template = editor.querySelector('[data-initial-set-template]');
    rules.append(template.content.cloneNode(true));
    rules.lastElementChild.querySelector('input')?.focus();
  } else {
    const rule = button.closest('[data-initial-set-rule]');
    const neighbour = rule.nextElementSibling ?? rule.previousElementSibling;
    rule.remove();
    (neighbour?.querySelector('[data-initial-set-remove]') ?? editor.querySelector('[data-initial-set-add]')).focus();
  }
  editor.querySelector('[data-initial-set-empty]').hidden = rules.children.length > 0;
  return true;
}

export function readInitialSetSchedule(formData) {
  const starts = formData.getAll('initialSetStart');
  const ends = formData.getAll('initialSetEnd');
  const sets = formData.getAll('initialSetId');
  if (starts.length !== ends.length || starts.length !== sets.length) throw new Error('時間帯別セットの一覧を確認してください。');
  return starts.map((start, index) => ({ start, end: ends[index], setId: sets[index] }));
}
