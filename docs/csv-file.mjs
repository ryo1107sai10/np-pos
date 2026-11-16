function csvCell(value) {
  const raw = String(value ?? '');
  const text = typeof value === 'string' && /^\s*[=+\-@＝＋－＠]/u.test(raw) ? "'" + raw : raw;
  return /[",\r\n]/.test(text) ? '"' + text.replaceAll('"', '""') + '"' : text;
}

export function encodeCsv(rows) {
  return '\uFEFF' + rows.map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
