import { isRegisterCashAmount } from './register-cash.mjs';

export const defaultRegisterSettings = Object.freeze({cutoff:'06:00',hoursStart:'20:00',hoursEnd:'05:00',openingMode:'fixed',openingCash:20_000});
export const attendanceTimeUnits = Object.freeze([1,15,30,60]);
const minute = 60_000;
const japanDate = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
});

const validTime = (value) => typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);

export function getRegisterSettings(state) {
  return {...defaultRegisterSettings,...state.controls?.register};
}

export function normalizeRegisterSettings(settings) {
  if (!settings || ![settings.cutoff,settings.hoursStart,settings.hoursEnd].every(validTime)
      || !['fixed','previous'].includes(settings.openingMode) || !isRegisterCashAmount(settings.openingCash)
      || (settings.attendanceTimeUnit !== undefined && !attendanceTimeUnits.includes(settings.attendanceTimeUnit))) {
    throw new Error('営業日切替時刻・営業時間・開店準備金・勤怠の時間単位を確認してください。');
  }
  const {cutoff,hoursStart,hoursEnd,openingMode,openingCash,attendanceTimeUnit} = settings;
  return {cutoff,hoursStart,hoursEnd,openingMode,openingCash,...(attendanceTimeUnit !== undefined && {attendanceTimeUnit})};
}

export function getAttendanceTimeUnit(state) {
  return getRegisterSettings(state).attendanceTimeUnit ?? 1;
}

export function getAttendanceMinutes(clockInAt,clockOutAt,breakMinutes,timeUnit = 1) {
  if (timeUnit === 1) return Math.floor((clockOutAt - clockInAt) / minute) - breakMinutes;
  const unit = timeUnit * minute;
  const start = Math.ceil(clockInAt / unit);
  const end = Math.floor(clockOutAt / unit);
  return Math.max(0,(end - start) * timeUnit - breakMinutes);
}

export function registerCutoff(state) {
  const [hours,minutes] = getRegisterSettings(state).cutoff.split(':').map(Number);
  return hours * 60 + minutes;
}

export function businessDate(now = Date.now(), cutoffMinutes = 360) {
  const parts = Object.fromEntries(japanDate.formatToParts(new Date(now - cutoffMinutes * 60_000))
    .map(({type,value}) => [type,value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function operationBusinessDate(state, now = Date.now()) {
  return state.day.status === 'open' ? state.day.date : businessDate(now,registerCutoff(state));
}

export function openingCashSuggestion(state,date) {
  const {openingMode,openingCash} = getRegisterSettings(state);
  if (openingMode === 'fixed') return openingCash;
  const close = state.closedDays.filter((row) => row.date < date && isRegisterCashAmount(row.actualCash))
    .sort((left,right)=>right.date.localeCompare(left.date))[0];
  return close?.actualCash ?? openingCash;
}
