import { monthlyPayrollSections, payrollStatementNote, payrollSummaryAmounts, payrollWorkRows } from './payroll-statement-layout.mjs';

const encoder = new TextEncoder();
const pageWidth = 595.28;
const pageHeight = 841.89;
const margin = 46;
const yen = new Intl.NumberFormat('ja-JP',{style:'currency',currency:'JPY'});
const fileLabel = (name) => [...String(name).replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g,'_').trim()].slice(0,80).join('') || 'キャスト';

function money(label,amount) {
  return [label,yen.format(amount || 0)];
}

function baseSections(pay) {
  return [
    ['支給内訳',payrollSummaryAmounts(pay).map(([label,amount]) => money(label,amount))],
    ['勤務の内訳',payrollWorkRows(pay.work,yen.format)],
  ];
}

function monthlyStatement({month,snapshot:pay}) {
  return {title:'支給明細',period:month,filenamePeriod:month,castName:pay.castName,totalLabel:'支給合計',total:pay.net,
    sections:monthlyPayrollSections(pay,yen.format),note:payrollStatementNote};
}

function rangeStatement({start,end,snapshot:pay}) {
  const sections = [
    ...baseSections(pay),
    ['確定歩合の内訳（丸め前）',pay.commissionDetails.map(({month,name,amount}) => money(`${month} ／ ${name}`,amount))],
    ['勤怠項目の内訳',pay.attendanceDetails.map(({month,label,amount,kind}) => kind === 'points'
      ? [`${month} ／ ${label}`,`${amount} pt`] : money(`${month} ／ ${label}`,kind === 'deduction' ? -amount : amount))],
    ['日払いの内訳（支給日）',pay.advances.map(({paidDate,month,amount,method}) =>
      money(`${paidDate} ／ ${method === 'cash' ? '現金' : '振込'} ／ ${month}分`,-amount))],
  ];
  return {title:'給与期間参考明細',period:start === end ? start : `${start} 〜 ${end}`,
    filenamePeriod:start === end ? start : `${start}_${end}`,castName:pay.castName,totalLabel:'差引参考額',total:pay.net,sections,
    note:'勤怠・確定歩合は営業日、日払いは支給日を基準にしています。対象期間内の時給・歩合・ポイントの換金額を給与月ごとに丸めています。月次テンプレートと日付のない手当・控除・日払い調整は月次の確定明細で確認できます。'};
}

function wrapText(context,value,width) {
  const lines = [];
  for (const paragraph of String(value).split(/\r?\n/)) {
    let line = '';
    for (const character of paragraph) {
      if (line && context.measureText(line + character).width > width) {
        lines.push(line);
        line = '';
      }
      line += character;
    }
    lines.push(line);
  }
  return lines;
}

function canvasJpeg(canvas) {
  return new Promise((resolve,reject) => canvas.toBlob((blob) => {
    if (blob) resolve(blob);
    else reject(new Error('支給明細のPDFを作成できませんでした。'));
  },'image/jpeg',0.9));
}

async function renderStatementPages({title,period,castName,totalLabel,total,sections,note},storeName) {
  const canvas = document.createElement('canvas');
  const scale = 2.5;
  canvas.width = Math.ceil(pageWidth * scale);
  canvas.height = Math.ceil(pageHeight * scale);
  const context = canvas.getContext('2d',{alpha:false});
  if (!context) throw new Error('このブラウザーではPDFを作成できません。');
  context.scale(canvas.width / pageWidth,canvas.height / pageHeight);
  const pages = [];
  const lineHeight = 20;
  let top;
  const font = (size,weight = 'normal') => {
    context.font = `${weight} ${size}px "Hiragino Sans", "Yu Gothic", "Noto Sans CJK JP", sans-serif`;
  };
  function text(value,x,y,{size = 11,weight = 'normal',color = '#202c3f',align = 'left'} = {}) {
    font(size,weight);
    context.fillStyle = color;
    context.textAlign = align;
    context.fillText(value,x,y);
  }
  function rule(y) {
    context.fillStyle = '#d9e0e9';
    context.fillRect(margin,y,pageWidth - 2 * margin,0.5);
  }
  function beginPage() {
    context.fillStyle = '#fff';
    context.fillRect(0,0,pageWidth,pageHeight);
    text(title,margin,66,{size:24,weight:'bold'});
    text(period,pageWidth - margin,66,{size:13,weight:'bold',align:'right'});
    font(11);
    top = 90;
    for (const line of wrapText(context,`${storeName} ／ ${castName}`,pageWidth - 2 * margin)) {
      text(line,margin,top);
      top += lineHeight;
    }
    rule(top);
    top += 24;
  }
  async function finishPage() {
    rule(pageHeight - 46);
    text(String(pages.length + 1),pageWidth - margin,pageHeight - 27,{size:9,align:'right'});
    pages.push(await canvasJpeg(canvas));
  }
  async function ensureSpace(height) {
    if (top + height <= pageHeight - 68) return false;
    await finishPage();
    beginPage();
    return true;
  }
  function sectionTitle(title) {
    text(title,margin,top,{size:13,weight:'bold'});
    top += 20;
  }
  beginPage();
  text(totalLabel,margin,top + 3,{size:13,weight:'bold'});
  text(yen.format(total),pageWidth - margin,top + 3,{size:20,weight:'bold',align:'right'});
  top += 32;
  for (const [title,rows] of sections) {
    if (!rows.length) continue;
    await ensureSpace(42);
    sectionTitle(title);
    for (const [label,value] of rows) {
      font(11);
      const labelWidth = pageWidth - 2 * margin - context.measureText(value).width - 16;
      const lines = wrapText(context,label,labelWidth);
      if (await ensureSpace(lines.length * lineHeight + 22)) sectionTitle(`${title}（続き）`);
      text(value,pageWidth - margin,top,{align:'right'});
      for (const line of lines) {
        text(line,margin,top);
        top += lineHeight;
      }
      rule(top - 12);
    }
    top += 13;
  }
  font(9);
  const notes = wrapText(context,note,pageWidth - 2 * margin);
  await ensureSpace(notes.length * lineHeight);
  for (const line of notes) {
    text(line,margin,top,{size:9});
    top += lineHeight;
  }
  await finishPage();
  const result = makeImagePdf(pages,canvas.width,canvas.height);
  canvas.width = canvas.height = 0;
  return result;
}

export function makeImagePdf(images,width,height) {
  const chunks = [];
  const offsets = [0];
  let length = 0;
  function append(data) {
    chunks.push(data);
    length += typeof data === 'string' ? data.length : data.size;
  }
  function object(id,body,stream) {
    offsets[id] = length;
    append(`${id} 0 obj\n${body}\n`);
    if (stream) {
      append('stream\n');
      append(stream);
      append('\nendstream\n');
    }
    append('endobj\n');
  }
  append('%PDF-1.4\n');
  object(1,'<< /Type /Catalog /Pages 2 0 R >>');
  object(2,`<< /Type /Pages /Count ${images.length} /Kids [${images.map((_,index) => `${index * 3 + 3} 0 R`).join(' ')}] >>`);
  for (const [index,image] of images.entries()) {
    const page = index * 3 + 3;
    const operators = `q\n${pageWidth} 0 0 ${pageHeight} 0 0 cm\n/Im1 Do\nQ\n`;
    object(page,`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /XObject << /Im1 ${page + 1} 0 R >> >> /Contents ${page + 2} 0 R >>`);
    object(page + 1,`<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${image.size} >>`,image);
    object(page + 2,`<< /Length ${operators.length} >>`,operators);
  }
  const xref = length;
  append(`xref\n0 ${offsets.length}\n0000000000 65535 f \n`);
  for (const offset of offsets.slice(1)) append(`${String(offset).padStart(10,'0')} 00000 n \n`);
  append(`trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(chunks,{type:'application/pdf'});
}

const crcTable = Array.from({length:256},(_,index) => {
  let crc = index;
  for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  return crc;
});

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255];
  return (crc ^ 0xffffffff) >>> 0;
}

export async function makeStoredZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  let centralSize = 0;
  const zipLimit = 0xffffffff;
  const tooLarge = 'PDFの合計が大きすぎます。期間やキャストを絞って出力してください。';
  if (entries.length > 0xffff) throw new Error(tooLarge);
  for (const {name,blob} of entries) {
    const filename = encoder.encode(name);
    const size = blob.size;
    if (filename.length > 0xffff || offset + size + 30 + filename.length > zipLimit) throw new Error(tooLarge);
    const checksum = crc32(new Uint8Array(await blob.arrayBuffer()));
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0,0x04034b50,true);
    local.setUint16(4,20,true);
    local.setUint16(6,0x0800,true);
    local.setUint16(12,33,true);
    local.setUint32(14,checksum,true);
    local.setUint32(18,size,true);
    local.setUint32(22,size,true);
    local.setUint16(26,filename.length,true);
    chunks.push(local.buffer,filename,blob);
    const header = new DataView(new ArrayBuffer(46));
    header.setUint32(0,0x02014b50,true);
    header.setUint16(4,20,true);
    new Uint8Array(header.buffer).set(new Uint8Array(local.buffer,4,26),6);
    header.setUint32(42,offset,true);
    central.push(header.buffer,filename);
    offset += 30 + filename.length + size;
    centralSize += 46 + filename.length;
  }
  if (offset + centralSize + 22 > zipLimit) throw new Error(tooLarge);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0,0x06054b50,true);
  end.setUint16(8,entries.length,true);
  end.setUint16(10,entries.length,true);
  end.setUint32(12,centralSize,true);
  end.setUint32(16,offset,true);
  return new Blob([...chunks,...central,end.buffer],{type:'application/zip'});
}

async function createStatementZip(statements,storeName) {
  const entries = [];
  const names = new Set();
  for (const [index,statement] of statements.entries()) {
    const {title,filenamePeriod,castName} = statement;
    const base = `${title}_${filenamePeriod}_${fileLabel(castName)}`;
    let name = `${base}.pdf`;
    let suffix = index + 1;
    while (names.has(name)) name = `${base}_${suffix++}.pdf`;
    names.add(name);
    entries.push({name,blob:await renderStatementPages(statement,storeName)});
  }
  return makeStoredZip(entries);
}

export function createPayrollZip(records,storeName) {
  return createStatementZip(records.map(monthlyStatement),storeName);
}

export function createPayrollRangeZip(records,storeName) {
  return createStatementZip(records.map(rangeStatement),storeName);
}
