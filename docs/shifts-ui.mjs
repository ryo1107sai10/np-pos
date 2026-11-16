import { listShifts, shiftPeriod } from './shifts.mjs';

const modes = { day:'日別',week:'週別',month:'月別' };
const statuses = { requested:'勤務希望',confirmed:'確定' };
const dayLabel = new Intl.DateTimeFormat('ja-JP',{timeZone:'UTC',month:'numeric',day:'numeric',weekday:'short'});

function timeValue(minute) {
  return `${String(Math.floor(minute / 60) % 24).padStart(2,'0')}:${String(minute % 60).padStart(2,'0')}`;
}

function peopleById(state) {
  return new Map([...(state.archivedCast ?? []),...state.cast].map((person) => [person.id,person.name]));
}

export function renderShifts(state,{date = state.day.date,mode = 'week',escape,icon,canEdit = true}) {
  const period = shiftPeriod(date,mode);
  const records = listShifts(state,period);
  const people = peopleById(state);
  const byDate = new Map();
  for (const record of records) {
    const current = byDate.get(record.date) ?? [];
    current.push(record);
    byDate.set(record.date,current);
  }
  if (!byDate.has(date)) byDate.set(date,[]);
  const groups = [...byDate].sort(([first],[second]) => first.localeCompare(second)).map(([day,shifts]) =>
    `<section class="np-shift-day">
      <header><h3><time datetime="${escape(day)}">${escape(dayLabel.format(new Date(day)))}</time></h3>
        ${canEdit ? `<button type="button" class="btn btn-quiet" data-action="shift-new" data-date="${escape(day)}" aria-label="${escape(day)}に追加">${icon('plus',16)}追加</button>` : ''}</header>
      ${shifts.length ? `<ul>${shifts.map((shift) => `<li>${canEdit
        ? `<button type="button" class="np-shift-row" data-action="shift-edit" data-id="${escape(shift.id)}">`
        : '<div class="np-shift-row">' }
        <strong>${escape(people.get(shift.castId) ?? shift.castId)}</strong>
        <span class="np-shift-time">${timeValue(shift.startMinute)}–${shift.endMinute >= 1_440 ? '翌 ' : ''}${timeValue(shift.endMinute)}</span>
        <span class="np-shift-status${shift.status === 'confirmed' ? ' np-shift-confirmed' : ''}">${statuses[shift.status]}</span>${canEdit ? icon('chevron-right',15) : ''}
        ${shift.note ? `<small>${escape(shift.note)}</small>` : ''}${canEdit ? '</button>' : '</div>'}</li>`).join('')}</ul>` : '<p class="field-help">登録されたシフトはありません。</p>'}</section>`).join('');
  return `<section class="np-shifts" aria-label="シフト管理">
    <div class="np-shift-toolbar">
      <div class="seg" role="group" aria-label="表示期間">${Object.entries(modes).map(([id,label]) =>
        `<button type="button" data-action="shift-period" data-id="${id}" aria-pressed="${id === mode}">${label}</button>`).join('')}</div>
      <div class="np-shift-navigation">
        <button type="button" class="btn btn-quiet" data-action="shift-navigate" data-date="${escape(period.previous)}" aria-label="前の期間">${icon('chevron-right',15)}</button>
        <label class="field"><span class="sr-only">表示の基準日</span><input type="date" data-shift-date value="${escape(date)}" required></label>
        <button type="button" class="btn btn-quiet" data-action="shift-navigate" data-date="${escape(period.next)}" aria-label="次の期間">${icon('chevron-right',15)}</button>
      </div>
      ${canEdit ? `<button type="button" class="btn btn-primary np-shift-new" data-action="shift-new" data-date="${escape(date)}">${icon('plus',16)}シフトを登録</button>` : ''}
    </div>
    <p class="np-shift-summary"><strong>${escape(period.start)}${period.end === period.start ? '' : ` – ${escape(period.end)}`}</strong><span>確定 ${records.filter(({status}) => status === 'confirmed').length}件 · 勤務希望 ${records.filter(({status}) => status === 'requested').length}件</span></p>
    <div class="np-shift-days">${groups}</div>
  </section>`;
}

export function renderShiftEditor(state,{shiftId,date = state.day.date,escape}) {
  const current = (state.shifts ?? []).find(({id}) => id === shiftId);
  const people = state.cast.filter(({enabled}) => enabled !== false);
  if (current && !people.some(({id}) => id === current.castId)) {
    const person = peopleById(state).get(current.castId);
    if (person) people.push({id:current.castId,name:person});
  }
  const options = people.map(({id,name}) =>
    `<option value="${escape(id)}"${current?.castId === id ? ' selected' : ''}>${escape(name)}</option>`).join('');
  return `<div class="np-shift-editor">
    <div class="form-grid">
      <label class="field"><span>キャスト</span><select name="shiftCastId" required>${options || '<option value="">キャストを登録してください</option>'}</select></label>
      <label class="field"><span>営業日</span><input type="date" name="shiftDate" value="${escape(current?.date ?? date)}" required></label>
      <label class="field"><span>開始時刻</span><input type="time" name="shiftStart" value="${timeValue(current?.startMinute ?? 1_200)}" required></label>
      <label class="field"><span>終了時刻</span><input type="time" name="shiftEnd" value="${timeValue(current?.endMinute ?? 1_500)}" required></label>
    </div>
    <label class="np-shift-overnight"><input type="checkbox" name="shiftOvernight"${(current?.endMinute ?? 1_500) >= 1_440 ? ' checked' : ''}>終了は翌日</label>
    <label class="field"><span>状態</span><select name="shiftStatus">${Object.entries(statuses).map(([key,label]) =>
      `<option value="${key}"${current?.status === key ? ' selected' : ''}>${label}</option>`).join('')}</select></label>
    <label class="field"><span>メモ（任意）</span><input type="text" name="shiftNote" maxlength="120" value="${escape(current?.note ?? '')}"></label>
    ${current ? `<button type="button" class="btn btn-danger" data-action="shift-remove" data-id="${escape(current.id)}">シフトを削除</button>` : ''}
  </div>`;
}

function parseTime(value) {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value ?? '');
  if (!match) throw new Error('開始時刻と終了時刻を入力してください。');
  return (Number(match[1]) * 60) + Number(match[2]);
}

export function readShiftForm(form) {
  const fields = form instanceof FormData ? form : new FormData(form);
  const startMinute = parseTime(fields.get('shiftStart'));
  const endMinute = parseTime(fields.get('shiftEnd')) + (fields.has('shiftOvernight') ? 1_440 : 0);
  if (endMinute <= startMinute || endMinute - startMinute > 1_440) throw new Error('終了時刻が開始時刻より後になるように、時刻と翌日指定を確認してください。');
  return {castId:fields.get('shiftCastId'),date:fields.get('shiftDate'),startMinute,endMinute,status:fields.get('shiftStatus'),note:fields.get('shiftNote') ?? ''};
}
