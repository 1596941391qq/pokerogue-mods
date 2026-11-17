// Engine extension d: HP going up and down, for 生命红绳 #15, 友谊宝珠 #16, 回复口袋 #14, 吃不完的拉面 #22.
// What it gives the mods (described for mod authors at the end of this comment, 简体中文):
//   events   healDone      a heal phase is finished (HP moved, its message queued): the place to answer a heal
//            hpLost        a Pokémon really lost HP (move hits, weather, recoil, poison, burn, Pain Split ...)
//            medicineUsed  an HP medicine was used from the reward screen or the shop
//   battle   B.canHeal(p)             can an in-battle heal restore anything for p right now
//            B.healExact(p, n, opts)  like B.heal, but exactly n HP (回复护符 does not multiply it)
//            B.restoreHp(p, n)        HP for a Pokémon outside battle (the bench), no animation
// Hooks (all wrap and pass through; with no mod on the game's own methods are called directly):
//   PokemonHealPhase.doHealPokemon / heal / getHealAmount   (tag 'd')
//   Pokemon.damage / Pokemon.damageAndUpdate                (tag 'd')
//   BattleScene.addModifier                                 (tag 'd')
// Nothing here knows an item: the items are in mod/items/d.js.
//
// ---- 给 mod 作者（接口版本 2 的补充，team d）----
// 事件
//   healDone      一次战斗中的回复做完之后（HP 已经加上，它自己的提示也排好了）。和 `heal` 的区别：`heal` 在
//                 HP 刚加上的那一瞬间来，这时再排一次回复会抢在原来那句提示前面；想「跟着回复再做点什么」用这个。
//                 只管游戏的回复阶段（招式、特性、树果、吃剩的东西、贝壳之铃、B.heal、B.healExact），
//                 分担痛楚、再生力这类直接改 HP 的不算。
//                 收到：pokemon、amount（实际回复的量，一定大于 0）、tag（B.heal / B.healExact 写的 tag，否则 null）、
//                 revive（是复活种子那样的复活）。
//   hpLost        一只宝可梦的 HP 真的减少之后（招式、天气、反伤、中毒、灼伤、分担痛楚都算）。
//                 收到：pokemon、amount（实际减少的量）、fainted（这一下倒下了）。
//   medicineUsed  在战斗外（奖励界面、商店）用了一件回复 HP 的药（伤药、好伤药、厉害伤药、全满药、全复药、
//                 活力碎片、活力块、圣灰）并且真的生效之后。
//                 收到：targets（药用在了哪些宝可梦身上；圣灰是被它救起来的那些）、revive（是复活类的药）、
//                 item（药的名字）、effectOn(p)（这件药用在 p 身上按游戏的算法能回复多少 HP，不看 p 现在缺多少）、
//                 screen（第几个奖励界面；在同一个界面上连用几件药，这个数不变）。
// 战场 api.battle
//   canHeal(p)             p 在场上、没倒下、HP 没满、没被「回复封锁」：现在给它回复有用吗
//   healExact(p, n, opts)  和 heal 一样排一次回复，但正好回复 n 点（回复护符不加成）。opts 同 heal：message、tag、quiet。
//                          回复不了（见 canHeal）或 n 不大于 0 时返回 false
//   restoreHp(p, n)        给不在战斗中的宝可梦（比如没上场的）直接加 HP，没有动画；倒下的不加。返回实际加了多少
CoopModsExt('d', X => {
  const B = X.battle;
  X.addEvent('healDone');
  X.addEvent('hpLost');
  X.addEvent('medicineUsed');

  const standing = p => !!(p && B.onField(p));
  const healBlocked = p => X.guard('d heal block', () => !!(p.getTag && p.getTag('HEAL_BLOCK')), false);
  // the team's 回复护符 multiplier (1 when there are none), read the way the game does
  const charm = () => X.guard('d charm', () => {
    const h = { value: 1 };
    (X.scene().modifiers || []).filter(m => m && m.constructor && m.constructor.name === 'HealingBoosterModifier').forEach(m => m.apply(h));
    return h.value > 0 && isFinite(h.value) ? h.value : 1;
  }, 1);

  X.extendBattle({
    canHeal: p => X.guard('d canHeal', () => standing(p) && !p.isFullHp() && !healBlocked(p), false),
    healExact(p, amount, opts) {
      return X.guard('d healExact', () => {
        const o = opts || {};
        amount = Math.floor(Number(amount) || 0);
        if (!(amount > 0) || !B.canHeal(p)) return false;
        const pm = X.scene().phaseManager;
        const ph = pm.create('PokemonHealPhase', p.getBattlerIndex(), amount, { message: o.message ? String(o.message) : undefined, showFullHpMessage: false, skipAnim: !!o.quiet });
        ph.__coopModHeal = { tag: o.tag == null ? null : String(o.tag) }; // the core's `heal` event reads the tag from here
        ph.__dExact = true;
        pm.unshiftPhase(ph);
        return true;
      }, false);
    },
    restoreHp(p, amount) {
      return X.guard('d restoreHp', () => {
        amount = Math.floor(Number(amount) || 0);
        if (!p || !(amount > 0) || p.isFainted()) return 0;
        const before = p.hp;
        p.hp = Math.min(p.hp + amount, p.getMaxHp());
        if (p.hp !== before && p.updateInfo) Promise.resolve(p.updateInfo(true)).catch(() => {});
        return p.hp - before;
      }, 0);
    },
  });

  // ---- heals: PokemonHealPhase is the one door for healing in battle ----
  X.phaseClass('PokemonHealPhase', proto => {
    // the HP really gained (the phase's own number is capped at max HP, not at what was missing)
    X.wrap(proto, 'doHealPokemon', 'd', orig => function () {
      let p = null, before = 0;
      X.guard('d heal measure', () => { p = this.getPokemon(); before = p ? p.hp : 0; });
      const r = orig.apply(this, arguments);
      X.guard('d heal measure', () => { this.__dGain = p ? p.hp - before : 0; this.__dMon = p; });
      return r;
    });
    // an exact heal (B.healExact): the number as asked, without 回复护符
    X.after(proto, 'getHealAmount', 'd', self => {
      if (!self.__dExact || self.revive) return;
      return { value: Math.min(Math.max(0, Math.floor(self.hpHealed)), self.getPokemon().getMaxHp()) };
    });
    // when heal() is through, the HP has moved and the phase's own message is queued: tell the mods
    X.wrap(proto, 'heal', 'd', orig => function () {
      const r = orig.apply(this, arguments);
      const done = () => X.guard('d healDone', () => {
        const gain = this.__dGain, p = this.__dMon;
        this.__dGain = 0;
        if (!(gain > 0) || !p || !X.has('healDone')) return;
        X.emit('healDone', { pokemon: p, amount: gain, tag: this.__coopModHeal ? this.__coopModHeal.tag : null, revive: !!this.revive });
      });
      if (r && typeof r.then === 'function') return r.then(v => { done(); return v; });
      done();
      return r;
    });
  });

  // ---- losses: every HP loss goes through Pokemon.damage; most come by way of damageAndUpdate ----
  // hpLost is told when the game's own call is through: after damageAndUpdate has returned for losses that
  // came through it, right away for the ones that call damage directly (poison, burn, Pain Split).
  let depth = 0, pending = [];
  const tell = list => { for (const ev of list) X.guard('d hpLost', () => { if (X.has('hpLost')) X.emit('hpLost', ev); }); };
  X.pokemonClass(proto => {
    X.after(proto, 'damage', 'd', (self, args, lost) => {
      if (!(lost > 0) || !X.has('hpLost')) return;
      const ev = { pokemon: self, amount: lost, fainted: self.isFainted() };
      if (depth > 0) pending.push(ev); else tell([ev]);
    });
    X.wrap(proto, 'damageAndUpdate', 'd', orig => function () {
      depth++;
      try { return orig.apply(this, arguments); } finally {
        depth--;
        if (depth <= 0) { depth = 0; if (pending.length) { const list = pending; pending = []; tell(list); } }
      }
    });
  });

  // ---- medicine: every use of an item goes through scene.addModifier ----
  const isHpMedicine = m => !!m && typeof m === 'object' && ((m.constructor && m.constructor.name === 'PokemonHpRestoreModifier')
    || ('restorePercent' in m && 'restorePoints' in m && 'fainted' in m && 'pokemonId' in m));
  let wrapped = null;
  const screen = { phase: null, n: 0 };
  X.onTick(s => {
    if (wrapped === s) return;
    const proto = X.protoWith(s, 'addModifier');
    if (!proto) return;
    X.wrap(proto, 'addModifier', 'd', orig => function (modifier) {
      let was = null;
      X.guard('d medicine', () => {
        if (!X.has('medicineUsed') || !isHpMedicine(modifier)) return;
        was = this.getPlayerParty().map(p => ({ p, hp: p.hp }));
      });
      const r = orig.apply(this, arguments); // true: the item did something to somebody (the shop takes the money on it)
      if (was && r) X.guard('d medicine', () => {
        const m = modifier, revive = !!m.fainted;
        // the Pokémon the game applied it to: the one it was used on (圣灰: everybody), alive for a potion, fainted for a revive
        const targets = was.filter(w => (m.pokemonId === -1 || w.p.id === m.pokemonId) && (w.hp <= 0) === revive).map(w => w.p);
        if (!targets.length) return;
        const mult = revive ? 1 : charm(), pts = Number(m.restorePoints) || 0, pct = Number(m.restorePercent) || 0;
        // the game's own formula (PokemonHpRestoreModifier.apply), for any Pokémon
        const effectOn = q => X.guard('d effectOn', () => Math.max(Math.ceil(Math.max(Math.floor(pct * 0.01 * q.getMaxHp()), revive ? pts : Math.floor(pts * mult))), 1), 0);
        // which reward screen this is (several medicines can be bought on one screen: the number stays the same)
        const ph = X.guard('d screen', () => this.phaseManager.getCurrentPhase(), null);
        if (ph !== screen.phase) { screen.phase = ph; screen.n++; }
        X.emit('medicineUsed', { targets, revive, item: (m.type && m.type.name) || '', effectOn, screen: screen.n });
      });
      return r;
    });
    wrapped = s;
  });

  // ---- for the rig ----
  X.debug('dCharm', () => charm());
  X.debug('dState', () => ({ depth, pending: pending.length, addModifier: !!wrapped }));
});
