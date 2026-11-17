function spreadsheetText(value) {
  const raw = String(value ?? '');
  return typeof value === 'string' && /^\s*[=+\-@＝＋－＠]/u.test(raw) ? "'" + raw : raw;
}

function csvCell(value) {
  const text = spreadsheetText(value);
  return /[",\r\n]/.test(text) ? '"' + text.replaceAll('"', '""') + '"' : text;
}

export function encodeCsv(rows) {
  return '\uFEFF' + rows.map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

export function encodeTsv(rows) {
  return '\uFEFF' + rows.map((row) => row.map((value) => spreadsheetText(value)
    .replace(/[\t\r\n]+/g, ' ')).join('\t')).join('\r\n') + '\r\n';
}
