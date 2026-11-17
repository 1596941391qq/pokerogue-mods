// Engine extension of team e: berries. For 文柚大果 #11, 哆啦A梦树果袋 #27, 异次元树果袋 #20,
// 超级巨化卡比兽玩偶 #21, 树果种植盆 #30 (mod/items/e.js). What it gives a mod (written up for mod authors, in
// 简体中文, at the end of notes/requests-e.md, ready for docs/MOD-API.md):
//   events    berryTime { pokemon }                          the game's berry moment, once per player Pokémon on the field
//             berryEaten { pokemon, berry, name, item, kept } a Pokémon really ate a berry (the game's, or a mod item used as one)
//                        (for a mod item eaten inside berryTime it is sent once that Pokémon's berryTime handlers are
//                        through, so the eater's own message and heals are queued before what a listener adds)
//   B.        hpRatio(p) berryName(t) berries(p) berryRoom(p) giveBerry(p, t) eatAsBerry(p, item) trimBerries(p)
//   api.      berryCap(item, n)                              each copy of that held item: +n to the holder's berry stacks
//             countsAsBerry(item)                            that held mod item's own max follows the same bonus (core: X.onMax)
// Hooks (all pass through; tags start with 'e'):
//   BerryPhase.eatBerries            after the game's own berries: berryEaten for what the game ate, then berryTime
//   Pokemon.recordEatenBerry         the one place every real eat goes through (BerryPhase, 大快朵颐, 茶会, 虫咬, 啄食)
//   BerryModifier.getMaxHeldItemCount  + the bonus declared with api.berryCap
//   BattleScene.tryTransferHeldItemModifier  a berry stack moved onto a Pokémon without that berry: not more than its own limit
//   gameData.parseSessionData        only reads the mod block of a save that is being loaded (see capBonus)
//   gameData.getSessionSaveData      only notes, in the cap item's state, which stacks are above the game's own limit
// With the mod off, or with none of these items held, every hook returns what the game returned.
CoopModsExt('e', X => {
  const B = X.battle;
  const scene = () => X.scene();
  const TYPES = 11; // BerryType 0..10: SITRUS LUM ENIGMA LIECHI GANLON PETAYA APICOT SALAC LANSAT STARF LEPPA
  const ZH = ['文柚果', '木子果', '谜芝果', '枝荔果', '龙睛果', '龙火果', '杏仔果', '沙鳞果', '兰萨果', '星桃果', '苹野果']; // only when the game gives no name
  const validType = t => Number.isInteger(t) && t >= 0 && t < TYPES;

  X.addEvent('berryTime');
  X.addEvent('berryEaten');

  // ---- the game's berry classes (not reachable by name: taken from a berry that exists, or made by the save reader) ----
  let TypeCtor = null; // BerryModifierType
  const isBerry = m => !!m && typeof m.is === 'function' && m.is('BerryModifier');
  function typeObj(t) {
    if (TypeCtor) return new TypeCtor(t);
    const s = scene();
    const any = (s.modifiers || []).concat(s.enemyModifiers || []).find(isBerry);
    let type = any && any.type ? new any.type.constructor(t) : null;
    if (!type) {
      // the save reader builds a BerryModifierType from its id ('BERRY') and the berry type; Cap stands in for the modifier class
      const raw = JSON.stringify({ modifiers: [{ typeId: 'BERRY', typePregenArgs: [t], args: [], stackCount: 1, className: 'BerryModifier' }] });
      const md = s.gameData.parseSessionData(raw).modifiers[0];
      const Cap = function (ty) { this.type = ty; this.stackCount = 1; };
      Cap.prototype.getMaxStackCount = () => 1;
      const got = md.toModifier(Cap);
      type = got && got.type;
    }
    if (!type || type.id !== 'BERRY') throw new Error('no BerryModifierType in this build');
    TypeCtor = type.constructor;
    return type;
  }
  const stackOf = (p, t) => scene().findModifier(m => isBerry(m) && m.berryType === t && m.pokemonId === p.id, p.isPlayer());
  // the limit of berry t for p (the game's 2 or 3, plus what the cap hook adds)
  const capOf = (p, t) => (stackOf(p, t) || typeObj(t).newModifier(p)).getMaxStackCount();
  const berryName = t => (validType(t) ? X.guard('e berryName', () => typeObj(t).name, ZH[t]) || ZH[t] : '树果');
  function berries(p) {
    const out = [];
    for (let t = 0; t < TYPES; t++) { const m = stackOf(p, t); out.push({ berry: t, name: berryName(t), count: m ? m.getStackCount() : 0, max: capOf(p, t) }); }
    return out;
  }
  // one more berry t for p, the way 收获 gives one back. false: at its limit (never the game's "stack full, take
  // a Poké Ball instead": the limit is checked here first), fainted, an enemy, or not a berry type.
  function giveBerry(p, t) {
    if (!p || !validType(t) || !p.isPlayer() || p.isFainted()) return false;
    const s = scene(), have = stackOf(p, t);
    if (have) {
      if (have.getStackCount() >= have.getMaxStackCount()) return false;
      have.stackCount++;
    } else {
      const mod = typeObj(t).newModifier(p);
      if (mod.getMaxStackCount() < 1) return false;
      s.addModifier(mod, true); // (its return value says nothing for a held item)
      if (!stackOf(p, t)) return false;
    }
    s.updateModifiers(true); // the item bar, the counts
    return true;
  }

  // ---- the berry limit: + what mods declared with api.berryCap(item, n) ----
  const caps = []; // { key, n }
  // A save that is being loaded: the game cuts every stack down to its limit while it rebuilds the items, and
  // that is before the engine has read who holds what in that save (it does so at its next tick). So the mod
  // block of the save just parsed is remembered here until the engine has caught up.
  // By run seed, because the title's slot list parses several saves before one of them is loaded.
  const pending = {}; // seed -> { pokemonId: { key: n } }
  function blockCounts(block) {
    const out = {};
    if (!block || typeof block !== 'object' || !block.held || typeof block.held !== 'object') return out;
    for (const id of Object.keys(block.held)) {
      const h = block.held[id];
      if (!h || typeof h !== 'object') continue;
      for (const k of Object.keys(h)) { const e = h[k]; const n = block.v === 1 ? (e ? 1 : 0) : e && e.n >= 1 ? Math.floor(e.n) : 0; if (n) (out[id] = out[id] || {})[k] = n; }
    }
    return out;
  }
  function notePending(r) {
    if (!r || !r.seed || !caps.length) return;
    let block = r.coopMods;
    if (!block) { try { const dev = JSON.parse(localStorage.getItem('coop-mods-held-v1') || '{}')[r.seed]; block = dev && dev.block; } catch {} } // the device copy the engine falls back on
    const seeds = Object.keys(pending);
    if (seeds.length > 12) delete pending[seeds[0]];
    pending[r.seed] = blockCounts(block);
  }
  function capBonus(p) {
    if (!p || typeof p.isPlayer !== 'function' || !p.isPlayer()) return 0;
    let sum = 0;
    for (const c of caps) {
      if (!X.itemOn(c.key)) continue;
      let n = X.count(p, c.key);
      const run = pending[scene().seed], h = run && run[p.id];
      if (h && h[c.key] > n) n = Math.min(h[c.key], X.items[c.key].max);
      sum += n * c.n;
    }
    return sum;
  }
  let capHooked = false;
  function hookCap(s) {
    if (capHooked || !caps.length) return;
    const proto = Object.getPrototypeOf(typeObj(0).newModifier({ id: 0 })); // a throw-away berry: never added to the game
    if (!proto || !Object.prototype.hasOwnProperty.call(proto, 'getMaxHeldItemCount')) throw new Error('BerryModifier.getMaxHeldItemCount not found');
    // (pokemon?) -> 2 or 3. The game calls it for the holder, for every party member (the red count) and with nothing.
    capHooked = X.wrap(proto, 'getMaxHeldItemCount', 'e', orig => {
      gameCap = orig; // what was there before this wrap: the game's 2 or 3 (plus whatever another extension added before)
      return function (pokemon) {
        const base = orig.apply(this, arguments);
        if (typeof base !== 'number') return base;
        return base + X.guard('e berry cap', () => capBonus(pokemon || (this.getPokemon && this.getPokemon())), 0);
      };
    });
    // moving a berry stack onto a Pokémon that has none of that berry: the game takes the whole quantity without
    // looking at the target's limit, which only shows once limits differ between Pokémon
    const sp = X.protoWith(s, 'tryTransferHeldItemModifier');
    if (sp) X.before(sp, 'tryTransferHeldItemModifier', 'e', (self, args) => {
      const item = args[0], target = args[1];
      if (!caps.length || !isBerry(item) || !target || !target.isPlayer() || typeof item.getMaxHeldItemCount !== 'function') return;
      if (self.findModifier(m => isBerry(m) && m.berryType === item.berryType && m.pokemonId === target.id, true)) return; // the game checks this case itself
      const max = item.getMaxHeldItemCount(target), want = args[3] == null ? 1 : args[3];
      if (!(want > max)) return;
      const a = args.slice(); while (a.length < 4) a.push(undefined);
      a[3] = Math.max(1, max);
      return { args: a };
    });
    const gd = s.gameData;
    if (gd && typeof gd.parseSessionData === 'function') X.after(gd, 'parseSessionData', 'e', (self, args, r) => { notePending(r); });
    if (gd && typeof gd.getSessionSaveData === 'function') X.before(gd, 'getSessionSaveData', 'e', () => { noteOver(); });
    X.log('hooks (e): berry limit');
    // the run was loaded before this hook existed (the room was opened, or the mod switched on, afterwards)
    X.guard('e cap late start', () => { if ((s.getPlayerParty() || []).length) { restoreOver(s); s.updateModifiers(true); } });
  }
  // A run loaded while this hook was not there yet had its larger stacks cut by the game. Every save notes them
  // in the cap item's state ({ over: { berryType: count } }), and they are put back when the hook goes in late
  // (and when the mod comes back on): only a stack that sits exactly at the game's own limit (what a cut
  // leaves) is raised again, and never above today's limit.
  let gameCap = null;
  const ownStacks = (s, p) => s.findModifiers(m => isBerry(m) && m.pokemonId === p.id, true);
  function noteOver() {
    const s = scene();
    if (!capHooked || !gameCap || !s || !s.findModifiers) return;
    for (const c of caps) for (const p of s.getPlayerParty() || []) {
      const st = X.state(p, c.key), over = {}; // (the state is there while the mod is off too)
      if (!st) continue;
      for (const m of ownStacks(s, p)) if (m.stackCount > gameCap.call(m, p)) over[m.berryType] = m.stackCount;
      if (Object.keys(over).length) st.over = over; else delete st.over;
    }
  }
  function restoreOver(s) {
    if (!gameCap) return;
    let n = 0;
    for (const c of caps) for (const p of X.holders(c.key)) { // (only while the item's mod is on)
      const st = X.state(p, c.key), over = st && st.over;
      if (!over || typeof over !== 'object') continue;
      for (const m of ownStacks(s, p)) {
        const want = Math.floor(Number(over[m.berryType]) || 0);
        if (want > m.stackCount && m.stackCount === gameCap.call(m, p)) { const to = Math.min(want, m.getMaxStackCount()); n += to - m.stackCount; m.stackCount = to; }
      }
    }
    if (n) X.log('berries above the game\'s limit put back: ' + n);
  }
  X.onTick(s => {
    if (!capHooked && caps.length && s.gameData && s.modifiers) hookCap(s);
    // the engine reads a run's items in this same tick, before the extensions: from here on X.count is right
    if (s.seed && pending[s.seed] && (s.getPlayerParty() || []).length) delete pending[s.seed];
  });
  // held mod items that count as berries (文柚大果, 哆啦A梦树果袋): their max per Pokémon is the item's own plus the
  // same bonus the game's berries get from the cap items. The core asks through X.onMax wherever it compares a
  // count with the max (give, canTake, the reward pick and its 已经带满了 text).
  const likes = new Set(); // item keys
  X.onMax((p, key, max) => (likes.has(key) ? max + capBonus(p) : max));
  // copies of those items above the Pokémon's limit of the moment (a cap item was taken away): they go, like berries
  function trimLikes(p) {
    let cut = 0;
    for (const key of likes) {
      if (!X.itemOn(key)) continue;
      const over = X.count(p, key) - X.maxOf(p, key);
      if (over > 0 && X.take(p, key, over)) cut += over;
    }
    return cut;
  }
  X.extendApi(mod => ({
    // this held item of yours counts as a berry for the cap items: its max per Pokémon goes up with them
    countsAsBerry(item) {
      const key = item && item.key, it = key && X.items[key];
      if (!it || it.mod !== mod.id || it.kind !== 'held') throw new Error('countsAsBerry: pass one of your own held items');
      likes.add(key);
    },
    // each copy of this held item raises every berry stack limit of its holder by n
    berryCap(item, n) {
      const key = item && item.key;
      n = Math.floor(Number(n == null ? 1 : n) || 0);
      if (!key || String(key).indexOf(mod.id + ':') !== 0) throw new Error('berryCap: pass one of your own items');
      if (!(n > 0)) throw new Error('berryCap: n must be a whole number above 0');
      if (!caps.some(c => c.key === key)) caps.push({ key, n });
    },
  }));
  // A stack above its limit is a state the game cannot handle: its "can this Pokémon take one more" check only
  // refuses a stack that is exactly at the limit, and one more berry picked for that Pokémon then turns into
  // the game's "stack full" replacement (5 Poké Balls). So when a limit drops (the item is gone, the mod is
  // switched off) the berries above it go too: the same cut the game makes itself when it loads a save.
  function trimBerries(p) {
    const s = scene();
    if (!s || !s.findModifiers || !(s.getPlayerParty() || []).length) return 0;
    let cut = 0;
    for (const m of s.findModifiers(x => isBerry(x) && (!p || x.pokemonId === p.id), true)) {
      const max = m.getMaxStackCount();
      if (max >= 1 && m.stackCount > max) { cut += m.stackCount - max; m.stackCount = max; }
    }
    s.updateModifiers(true); // counts and tint follow at once
    if (cut) X.log('berries above the limit taken away: ' + cut);
    return cut;
  }
  // The mod that owns a cap item is switched off: note the larger stacks, then cut them. Switched on again: put
  // back what that cut took (and what the game cut if a run was loaded while it was off).
  let wasOff = false;
  X.onSwitch((id, on) => {
    if (!capHooked || !window.CoopTeam || !caps.some(c => X.items[c.key] && X.items[c.key].mod === id)) return;
    X.guard('e switch', () => {
      const s = scene();
      if (!on) { wasOff = true; noteOver(); trimBerries(null); }
      else if (wasOff) { wasOff = false; if (s && (s.getPlayerParty() || []).length) { restoreOver(s); s.updateModifiers(true); } }
    });
  });

  // ---- eating ----
  // ctx: set while BerryPhase.eatBerries runs for one Pokémon and during the berryTime that follows
  let ctx = null;
  function ate(p, berry, item, kept) {
    if (!X.has('berryEaten')) return;
    const ev = { pokemon: p, berry, name: item ? (X.items[item] || {}).name || '' : berryName(berry), item: item || null, kept };
    // inside the game's loop over the items: tell the mods when it is done. Inside this Pokémon's berryTime: tell
    // them when its handlers are through, so what the eater's own item queued (its message, its heals) comes
    // before what a listener queues (the doll's "变出了一个…").
    if (ctx && (ctx.inGame || (ctx.inTime && ctx.pokemon === p))) ctx.queue.push(ev);
    else X.emit('berryEaten', ev);
  }
  X.pokemonClass(base => {
    const proto = Object.prototype.hasOwnProperty.call(base, 'recordEatenBerry') ? base : null;
    if (!proto) { X.log('hooks (e): no Pokemon.recordEatenBerry in this build'); return; }
    // (berryType, updateHarvest = true): every real eat, never 反刍's replay, never simulated
    X.after(proto, 'recordEatenBerry', 'e', (self, args) => {
      const t = args[0];
      if (!validType(t)) return;
      ate(self, t, null, ctx && ctx.inGame && ctx.pokemon === self ? args[1] === false : null);
    });
    X.log('hooks (e): berries eaten');
  });
  X.phaseClass('BerryPhase', proto => {
    // (pokemon): once per active Pokémon of both sides, fastest first. The game's berries are eaten inside.
    X.wrap(proto, 'eatBerries', 'e', orig => function (pokemon) {
      const mine = X.guard('e eatBerries', () => {
        if (!pokemon || !(X.has('berryTime') || X.has('berryEaten'))) return null;
        const player = pokemon.isPlayer();
        // asked before the game eats: afterwards the eaten stacks no longer match. true: the game shows the
        // use-item animation (or the "too nervous" message) for this Pokémon itself.
        const real = !!scene().findModifier(m => isBerry(m) && m.shouldApply(pokemon), player);
        return { pokemon, player, real, shown: real, queue: [], inGame: true, inTime: false };
      }, null);
      const prev = ctx;
      ctx = mine;
      let r;
      try { r = orig.apply(this, arguments); } finally { if (mine) mine.inGame = false; else ctx = prev; }
      if (mine) {
        const flush = () => X.guard('e berryEaten', () => { for (const ev of mine.queue.splice(0)) X.emit('berryEaten', ev); });
        flush();
        mine.inTime = true;
        X.guard('e berryTime', () => { if (mine.player && B.onField(pokemon) && X.has('berryTime')) X.emit('berryTime', { pokemon }); });
        mine.inTime = false;
        flush(); // the mod items eaten as berries during berryTime
        ctx = prev;
      }
      return r;
    });
    X.log('hooks (e): berry phase');
  });
  const nervous = p => p.getOpponents().some(o => o && o.isActive(true) && o.hasAbilityWithAttr('PreventBerryUseAbAttr'));
  // p uses one copy of a held mod item the way a berry is eaten. 'eaten': one copy is gone; 'kept': the team's
  // 树果袋 kept it; false: nothing happened (not held, not on the field, or 紧张感 on the other side).
  function eatAsBerry(p, item) {
    const key = item && item.key ? item.key : item;
    if (!X.itemOn(key) || !B.onField(p) || X.count(p, key) < 1) return false;
    const s = scene(), c = ctx && ctx.pokemon === p ? ctx : null, bi = p.getBattlerIndex();
    if (nervous(p)) {
      if (!(c && c.shown)) s.phaseManager.queueMessage(X.nameOf(p) + '因太紧张\n而无法食用树果！');
      if (c) c.shown = true;
      return false;
    }
    const keep = { value: false };
    X.guard('e berry pouch', () => { const pouch = s.findModifier(m => m.is('PreserveBerryModifier'), true); if (pouch) pouch.apply(p, keep); });
    if (!(c && c.shown)) s.phaseManager.unshiftNew('CommonAnimPhase', bi, bi, 2000 /* CommonAnim.USE_ITEM */);
    if (c) c.shown = true;
    if (!keep.value) X.take(p, key, 1);
    X.guard('e belch', () => { p.battleData.hasEatenBerry = true; }); // 打嗝 may be used from now on, as after any berry
    ate(p, null, key, !!keep.value);
    return keep.value ? 'kept' : 'eaten';
  }

  X.extendBattle({
    // HP as a share of max HP, rounded to whole percent the way the game does for its berries (49.6% reads 0.5)
    hpRatio: p => X.guard('e hpRatio', () => p.getHpRatio(), 1),
    berryName,
    // every berry type for this Pokémon: [{ berry, name, count, max }]
    berries: p => X.guard('e berries', () => berries(p), []),
    // the berry types this Pokémon can take one more of
    berryRoom: p => X.guard('e berryRoom', () => (!p || !p.isPlayer() || p.isFainted() ? [] : berries(p).filter(b => b.count < b.max).map(b => b.berry)), []),
    giveBerry: (p, t) => X.guard('e giveBerry', () => giveBerry(p, t), false),
    eatAsBerry: (p, item) => X.guard('e eatAsBerry', () => eatAsBerry(p, item), false),
    // cut this Pokémon's berry stacks down to their limits (after a limit dropped); returns how many went
    trimBerries: p => X.guard('e trimBerries', () => (p ? (capHooked ? trimBerries(p) : 0) + trimLikes(p) : 0), 0),
  });

  // ---- for tests ----
  X.debug('eBerries', i => berries(scene().getPlayerParty()[i]).filter(b => b.count).map(b => b.name + '×' + b.count + '/' + b.max));
  X.debug('eGiveBerry', (i, t) => giveBerry(scene().getPlayerParty()[i], t));
  X.debug('eCaps', () => ({ caps: caps.slice(), likes: [...likes], hooked: capHooked, pending: Object.keys(pending), type: !!TypeCtor }));
  X.debug('eType', t => { const ty = typeObj(t); return { id: ty.id, name: ty.name, ctor: ty.constructor.name, icon: ty.iconImage }; });
});
