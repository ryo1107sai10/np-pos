const clockTime = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const setIdPattern = /^[a-zA-Z0-9_-]{1,128}$/;
const minutesPerDay = 24 * 60;
const tokyoClock = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

export function getAvailableInitialSets(state) {
  return (state.menu ?? []).filter(({category, enabled}) => category === 'セット' && enabled !== false);
}

function toMinute(value) {
  if (typeof value !== 'string' || !clockTime.test(value)) return NaN;
  const [hour, minute] = value.split(':').map(Number);
  return hour * 60 + minute;
}

function normalizedRules(rules, activeSetIds) {
  if (!Array.isArray(rules) || rules.length > minutesPerDay) throw new Error('時間帯別セットの一覧を確認してください。');
  const scheduled = new Uint8Array(minutesPerDay);
  return Array.from(rules, (rule) => {
    const { start, end, setId } = rule ?? {};
    const from = toMinute(start);
    const until = toMinute(end);
    if (!Number.isFinite(from) || !Number.isFinite(until) || from === until) {
      throw new Error('開始と終了には異なる時刻を入力してください。');
    }
    if (typeof setId !== 'string' || !setIdPattern.test(setId) || (activeSetIds && !activeSetIds.has(setId))) {
      throw new Error('現在利用できる初回セットを選択してください。');
    }
    for (let minute = from; minute !== until; minute = (minute + 1) % minutesPerDay) {
      if (scheduled[minute]) throw new Error('時間帯が重ならないように設定してください。');
      scheduled[minute] = 1;
    }
    return { start, end, setId };
  }).sort((left, right) => left.start.localeCompare(right.start));
}

export function isValidInitialSetSchedule(rules) {
  if (rules === undefined) return true;
  try {
    normalizedRules(rules);
    return true;
  } catch {
    return false;
  }
}

export function applySetSchedule(state, action, actor) {
  if (actor?.role !== 'admin') throw new Error('時間帯別セットの変更には店舗管理者の権限が必要です。');
  const enabled = new Set(getAvailableInitialSets(state).map(({id}) => id));
  state.initialSetSchedule = normalizedRules(action.rules, enabled);
}

export function suggestInitialSet(state, at = Date.now()) {
  const rules = state.initialSetSchedule;
  if (!Array.isArray(rules) || rules.length === 0) return undefined;
  const minute = toMinute(tokyoClock.format(at));
  const rule = rules.find((entry) => {
    const {start, end} = entry ?? {};
    const from = toMinute(start);
    const until = toMinute(end);
    if (from < until) return minute >= from && minute < until;
    return from > until && (minute >= from || minute < until);
  });
  return rule && getAvailableInitialSets(state).find(({id}) => id === rule.setId);
}
