import { visitEndNoticeLeadMs } from './engine.mjs';

export function getVisitEndNotices(state, now, autoNotices = []) {
  if (state.day.status !== 'open') return [];
  const imminentAutomatic = new Map(autoNotices.map(({ticketId,deadline}) => [ticketId,deadline]));
  return state.tickets.filter((ticket) => ticket.status === 'open' && ticket.tableIds?.length
    && Number.isSafeInteger(ticket.endsAt) && ticket.endsAt <= now + visitEndNoticeLeadMs
    && imminentAutomatic.get(ticket.id) !== ticket.endsAt)
    .map(({id,tableIds,endsAt}) => ({ticketId:id,tableIds,deadline:endsAt,overdue:endsAt <= now}))
    .sort((first,second) => first.deadline - second.deadline);
}

export function visitEndNoticesKey(notices) {
  return notices.map(({ticketId,deadline,overdue}) => `${ticketId}:${deadline}:${overdue}`).join('|');
}

export function recordVisitEndAnnouncements(notices, announced, tableName) {
  const labels = [];
  for (const {ticketId,tableIds,deadline,overdue} of notices) {
    if (!overdue && announced.get(ticketId) !== deadline) {
      labels.push(tableIds.map(tableName).join('・'));
    }
    announced.set(ticketId,deadline);
  }
  return labels;
}

export function formatVisitEndCountdown(deadline, now) {
  const difference = deadline - now;
  const seconds = difference > 0 ? Math.ceil(difference / 1000) : Math.floor(-difference / 1000);
  const clock = `${String(Math.floor(seconds / 60)).padStart(2,'0')}:${String(seconds % 60).padStart(2,'0')}`;
  return `${difference > 0 ? '残り' : '超過'} ${clock}`;
}

export function renderVisitEndNotices(notices, now, {escape,icon,tableName}) {
  if (!notices.length) return '';
  return `<section class="visit-end-notices" aria-labelledby="visit-end-notice-title">
    <h2 id="visit-end-notice-title">${icon('clock',17)}終了時刻のお知らせ <small>${notices.length}組</small></h2>
    <ul>${notices.map(({ticketId,tableIds,deadline,overdue}) => `<li>
      <button type="button" data-action="visit-end-focus" data-id="${escape(ticketId)}">
        <strong>${escape(tableIds.map(tableName).join('・'))}<span class="sr-only">の伝票を開く</span></strong>
        <span class="visit-end-countdown${overdue ? ' visit-end-overdue' : ''}" data-visit-ends="${deadline}">${formatVisitEndCountdown(deadline,now)}</span>
        ${icon('chevron-right',14)}
      </button>
    </li>`).join('')}</ul>
  </section>`;
}
