import { isRegisterCashAmount } from './register-cash.mjs';

export const defaultRegisterSettings = Object.freeze({cutoff:'06:00',hoursStart:'20:00',hoursEnd:'05:00',openingMode:'fixed',openingCash:20_000});

const validTime = (value) => typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);

export function getRegisterSettings(state) {
  return {...defaultRegisterSettings,...state.controls?.register};
}

export function normalizeRegisterSettings(settings) {
  if (!settings || ![settings.cutoff,settings.hoursStart,settings.hoursEnd].every(validTime)
      || !['fixed','previous'].includes(settings.openingMode) || !isRegisterCashAmount(settings.openingCash)) {
    throw new Error('営業日切替時刻・営業時間・開店準備金を確認してください。');
  }
  const {cutoff,hoursStart,hoursEnd,openingMode,openingCash} = settings;
  return {cutoff,hoursStart,hoursEnd,openingMode,openingCash};
}

export function registerCutoff(state) {
  const [hours,minutes] = getRegisterSettings(state).cutoff.split(':').map(Number);
  return hours * 60 + minutes;
}

export function openingCashSuggestion(state,date) {
  const {openingMode,openingCash} = getRegisterSettings(state);
  if (openingMode === 'fixed') return openingCash;
  const close = state.closedDays.filter((row) => row.date < date && isRegisterCashAmount(row.actualCash))
    .sort((left,right)=>right.date.localeCompare(left.date))[0];
  return close?.actualCash ?? openingCash;
}
