const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8',{fatal:true});
const magic = new Uint8Array([78,80,66,1]);
const ivLength = 12;
const maxPartBytes = 8 * 1024 * 1024;
export const maxEncryptedBackupPartBytes = maxPartBytes + magic.length + ivLength + 16;
export const backupPrefix = 'np-pos/daily/v1';

export const backupColumns = Object.freeze({
  np_stores:['id','name','owner_uid','revision','created_at'],
  np_groups:['id','name','owner_uid','created_at'],
  np_group_stores:['store_id','group_id'],
  np_group_members:['group_id','uid','email','role'],
  np_group_invites:['id','group_id','email','role','created_at'],
  np_store_access_blocks:['store_id','uid','email','invite_id'],
  np_members:['store_id','uid','email','role'],
  np_invites:['id','store_id','email','role','created_at'],
  np_member_role_profiles:['store_id','uid','profile_id'],
  np_invite_role_profiles:['invite_id','profile_id'],
  np_state_chunks:['store_id','position','payload'],
  np_operations:['store_id','operation_id','actor_uid','operation','fingerprint','revision','recorded_at'],
  np_audit_events:['store_id','operation_id','revision','payload'],
});

export function backupPath(day,storeId,file) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !/^[A-Za-z0-9_-]{1,128}$/.test(storeId)
    || !(file === 'manifest' || /^part-[1-9][0-9]*$/.test(file))) throw new Error('Invalid backup key');
  return `${backupPrefix}/${day}/${storeId}/${file}.npb`;
}

export async function importBackupKey(secret) {
  if (typeof secret !== 'string' || !/^[A-Fa-f0-9]{64}$/.test(secret)) throw new Error('Invalid backup encryption key');
  const bytes = Uint8Array.from(secret.match(/../g), (hex) => Number.parseInt(hex,16));
  return crypto.subtle.importKey('raw',bytes,'AES-GCM',false,['encrypt','decrypt']);
}

export async function encryptBackupPart(key,path,value) {
  const data = encoder.encode(JSON.stringify(value));
  if (data.byteLength > maxPartBytes) throw new Error('Backup part exceeds the size limit');
  const iv = crypto.getRandomValues(new Uint8Array(ivLength));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({
    name:'AES-GCM',iv,additionalData:encoder.encode(path),
  },key,data));
  const result = new Uint8Array(magic.length + ivLength + ciphertext.length);
  result.set(magic);
  result.set(iv,magic.length);
  result.set(ciphertext,magic.length + ivLength);
  return result;
}

export async function decryptBackupPart(key,path,bytes) {
  if (bytes.byteLength < magic.length + ivLength + 16 || bytes.byteLength > maxEncryptedBackupPartBytes
    || !magic.every((value,index) => bytes[index] === value)) throw new Error('Invalid encrypted backup part');
  const offset = magic.length + ivLength;
  const data = await crypto.subtle.decrypt({
    name:'AES-GCM',iv:bytes.subarray(magic.length,offset),additionalData:encoder.encode(path),
  },key,bytes.subarray(offset));
  return JSON.parse(decoder.decode(data));
}
