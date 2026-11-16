const stores = [
  {id:'demo-store-main',name:'サンプル 本店'},
  {id:'demo-store-east',name:'サンプル 東口店'},
  {id:'demo-store-west',name:'サンプル 西口店'},
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function groupName(input) {
  const name = input.trim().normalize('NFC');
  assert(name && name.length <= 60 && !/[\p{Cc}\u2028\u2029]/u.test(name),'グループ名を60文字以内で入力してください。');
  return name;
}

export function createStoreGroupDemo() {
  const groups = [{
    id:'demo-group-main',name:'サンプル グループ',
    storeIds:stores.slice(0,2).map(({id}) => id),
    members:[{uid:'demo-manager',email:'manager@example.test',role:'manager'}],
    invites:[{id:'demo-invite-staff',email:'staff@example.test',role:'staff'}],
  }];
  let preview = null;
  const record = (id) => groups.find((group) => group.id === id);
  const canEdit = () => assert(preview === null,'管理者の表示に戻して操作してください。');
  const available = () => stores.filter(({id}) => groups.every(({storeIds}) => !storeIds.includes(id)));
  return {
    listStoreGroups() {
      const viewed = preview && record(preview.groupId)?.members.find(({uid}) => uid === preview.uid);
      const visible = viewed ? groups.filter(({id}) => id === preview.groupId) : preview ? [] : groups;
      return structuredClone({
        groups:visible.map((group) => ({
          id:group.id, name:group.name, role:viewed?.role ?? 'owner',
          stores:stores.filter(({id}) => group.storeIds.includes(id)).map((store) => ({...store,role:viewed?.role ?? 'admin'})),
          ...(!viewed && {members:group.members,invites:group.invites}),
        })),
        attachable:preview ? [] : available(),
      });
    },
    preview(groupId, uid) { preview = uid === null ? null : {groupId,uid}; },
    createStoreGroup(name) {
      canEdit();
      const group = {id:crypto.randomUUID(),name:groupName(name),storeIds:[],members:[],invites:[]};
      groups.push(group);
      return {group:{id:group.id,name:group.name,role:'owner'}};
    },
    renameStoreGroup(id, name) {
      canEdit();
      record(id).name = groupName(name);
    },
    setGroupStore(id, storeId, attach) {
      canEdit();
      const group = record(id);
      if (attach) {
        assert(available().some(({id}) => id === storeId),'グループ未登録の店舗を選択してください。');
        group.storeIds.push(storeId);
      } else group.storeIds = group.storeIds.filter((value) => value !== storeId);
    },
    inviteGroupMember(id, email, role) {
      canEdit();
      const group = record(id);
      email = email.trim().toLowerCase();
      assert(email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email),'メールアドレスを確認してください。');
      assert(['manager','staff'].includes(role),'グループ権限を選択してください。');
      assert(!group.members.some((member) => member.email === email),'このメールアドレスは既にグループに所属しています。');
      const existing = group.invites.find((invite) => invite.email === email);
      if (existing) existing.role = role;
      else group.invites.push({id:crypto.randomUUID(),email,role});
    },
    changeGroupMember(id, uid, role) {
      canEdit();
      const group = record(id);
      if (role === undefined) group.members = group.members.filter((member) => member.uid !== uid);
      else {
        assert(['manager','staff'].includes(role),'グループ権限を選択してください。');
        group.members.find((member) => member.uid === uid).role = role;
      }
    },
    revokeGroupInvite(id, inviteId) {
      canEdit();
      const group = record(id);
      group.invites = group.invites.filter((invite) => invite.id !== inviteId);
    },
    acceptDemoInvite(id, inviteId) {
      canEdit();
      const group = record(id);
      const invite = group.invites.find((invite) => invite.id === inviteId);
      assert(invite,'招待が見つかりません。');
      group.members.push({uid:crypto.randomUUID(),email:invite.email,role:invite.role});
      group.invites = group.invites.filter((invite) => invite.id !== inviteId);
    },
  };
}
