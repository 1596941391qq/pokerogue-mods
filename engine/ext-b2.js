// Engine extension of team b2: what the five team-bag items of better-coop-items v0.9 need from the game.
//   肉鸽骰子 rogue-dice #17        SelectModifierPhase.getRerollCost / rerollModifiers + the price label of the reward screen
//   银色之羽 silver-wing #23       SelectModifierPhase.getModifierCount
//   虹色之羽 rainbow-wing #24      the party's luck: SelectModifierPhase.getModifierTypeOptions, scene.updateAndShowText, Arena.randomSpecies
//   小小花束 tiny-bouquet #13      one more hidden roll of the reward screen that only a mint comes out of
//   捕捉口袋 catching-pocket #19   AttemptCapturePhase.start / failCatch
// The numbers (3 free rerolls, +1 option, +3 luck, x1.1, 30%) are the mod's (mod/items/b2.js); this file only
// turns the game into six events a mod can answer: rewardCount, rerollCost, rerolled, teamLuck, mintRate,
// ballThrown (described for mod authors in notes/requests-b2.md, to be taken into docs/MOD-API.md).
// Every hook passes through when nobody listens to its event, and an error in our part falls back to what
// the game (or the extension before us) answered.
CoopModsExt('b2', X => {
  const B = X.battle;
  const EVENTS = ['rewardCount', 'rerollCost', 'rerolled', 'teamLuck', 'mintRate', 'ballThrown'];
  EVENTS.forEach(n => X.addEvent(n));

  const scene = () => X.scene();
  const st = { // counters for tests (CoopMods.debug.b2())
    wraps: {}, count: 0, quotes: 0, rerolls: 0, free: 0, luckCalls: 0, luckSpecies: 0, shadows: 0, mintsFound: 0, mintsPut: 0, throws: 0, kept: 0, last: {},
  };
  const dbg = { mintRate: null }; // test override: a mint multiplier, whatever the mods say
  // every listener's answer to an event (X.emit only gives the last one); a listener's error is logged, not passed on
  function answers(name, ev) {
    const out = [];
    if (!X.has(name)) return out;
    for (const [m, fn] of X.listeners(name)) {
      const r = X.guard('b2 ' + name + ' (' + ((m && m.id) || '?') + ')', () => fn(ev));
      if (r !== undefined && r !== null) out.push(r);
    }
    return out;
  }
  // what a mod is told about the reward screen it is asked about
  function info(ph) {
    const c = ph && typeof ph.__coop === 'object' && ph.__coop ? ph.__coop : null; // host-team.js's tag (true on the prototype: not a tag)
    return { wave: B.wave(), round: c ? c.round || 0 : 0, picker: c ? c.picker || null : null, rerolls: (ph && ph.rerollCount) || 0, normal: !!ph && !ph.customModifierSettings };
  }
  const isDaily = () => { const s = scene(); return !!(s && s.gameMode && s.gameMode.isDaily); };

  // ---------------------------------------------------------------------------------------------------------
  // rerollCost / rerolled: the price of 刷新商店
  // A reroll that a mod made free does not count when the game doubles the price (2 ** rerollCount): after
  // three free ones the first paid reroll costs what the first reroll of the screen costs. The phase's own
  // rerollCount is never changed for anybody else (the seed rule, host-team.js's tag and the Voucher weight
  // read it); only the price calculation sees the smaller number, for the length of that one call.
  // A chain = one screen and its rerolls: it starts with rerollCount 0 and every reroll makes a phase with one
  // more. `chain` remembers the free rerolls of the chain on screen; a phase that is not the next link of it
  // (another wave, another round, a count that does not follow) gets the game's plain price.
  const chain = { wave: -1, round: -1, rc: 0, free: 0 };
  const roundOf = ph => info(ph).round;
  const freeIn = ph => (chain.free > 0 && ph.rerollCount > 0 && ph.rerollCount === chain.rc && chain.wave === B.wave() && chain.round === roundOf(ph) ? Math.min(chain.free, ph.rerollCount) : 0);
  const quotes = new WeakMap(); // phase -> the last { price, cost, label } we answered for it
  function gamePrice(ph, orig, args) {
    const rc = ph.rerollCount, u = freeIn(ph);
    if (!u) return orig.apply(ph, args);
    ph.rerollCount = rc - u;
    try { return orig.apply(ph, args); } finally { ph.rerollCount = rc; }
  }
  function quote(ph, price, lock) {
    const q = { price, cost: price, label: null };
    if (!(price > 0)) return q; // -1: no reroll on this screen; 0: free already
    const ev = { cost: price, price, lock: !!lock, ...info(ph) };
    for (const r of answers('rerollCost', ev)) {
      const c = typeof r === 'number' ? r : r && typeof r === 'object' ? r.cost : NaN;
      if (!Number.isFinite(c)) continue;
      q.cost = ev.cost = Math.max(0, Math.min(Math.floor(c), q.cost)); // a mod can make it cheaper, never dearer
      if (r && typeof r === 'object' && r.label != null) q.label = String(r.label);
    }
    if (q.cost === q.price) q.label = null;
    return q;
  }
  X.phaseClass('SelectModifierPhase', proto => {
    st.wraps.getRerollCost = X.wrap(proto, 'getRerollCost', 'b2', orig => function (lock) {
      const self = this, args = arguments;
      if (!X.has('rerollCost') && !freeIn(self)) return orig.apply(self, args);
      let price, got = false;
      const q = X.guard('b2 getRerollCost', () => { price = gamePrice(self, orig, args); got = true; return quote(self, price, lock); }, null);
      if (!q) return got ? price : orig.apply(self, args);
      st.quotes++; st.last.quote = q;
      quotes.set(self, q);
      return q.cost;
    });
    st.wraps.rerollModifiers = X.wrap(proto, 'rerollModifiers', 'b2', orig => function () {
      const self = this;
      let q = null;
      X.guard('b2 reroll (before)', () => {
        if (!X.has('rerollCost') && !X.has('rerolled') && !freeIn(self)) return;
        quotes.delete(self);
        self.getRerollCost(scene().lockModifierTiers); // the same question the game asks next: leaves our quote
        q = quotes.get(self) || null;
      });
      const ok = orig.apply(self, arguments); // true only when the reroll really happened (enough money, allowed)
      if (ok) X.guard('b2 reroll (after)', () => {
        const free = !!q && q.price > 0 && q.cost === 0;
        const before = freeIn(self); // free rerolls so far in this chain (0 for the first reroll of a screen)
        chain.wave = B.wave(); chain.round = roundOf(self); chain.rc = (self.rerollCount || 0) + 1; chain.free = before + (free ? 1 : 0);
        st.rerolls++; if (free) st.free++;
        if (q) X.emit('rerolled', { cost: q.cost, price: q.price, free, ...info(self) });
      });
      return ok;
    });
  });
  // the label under 刷新商店: the game writes ₽<cost>; a mod that made the reroll cheaper may give its own words
  let labelDone = false;
  function hookLabel(s) {
    if (labelDone || !s.ui || !Array.isArray(s.ui.handlers)) return;
    const h = s.ui.handlers.find(x => x && x.constructor && x.constructor.name === 'ModifierSelectUiHandler');
    const proto = h && X.protoWith(h, 'updateRerollCostText');
    if (!proto) return;
    labelDone = true;
    st.wraps.updateRerollCostText = X.after(proto, 'updateRerollCostText', 'b2', self => {
      if (!X.has('rerollCost')) return;
      const ph = scene().phaseManager.getCurrentPhase(), q = ph && quotes.get(ph);
      if (!q || !q.label || self.rerollCost !== q.cost || !self.rerollCostText) return;
      self.rerollCostText.setText(q.label);
      st.last.label = q.label;
    });
  }

  // ---------------------------------------------------------------------------------------------------------
  // rewardCount: how many options the normal reward after a battle shows. Not asked for a set list (a
  // phase with customModifierSettings: boss and rival rewards, mystery encounters, the second player's round,
  // the screens other extensions build), where the list is fixed anyway.
  X.phaseClass('SelectModifierPhase', proto => {
    st.wraps.getModifierCount = X.after(proto, 'getModifierCount', 'b2', (self, args, n) => {
      if (self.customModifierSettings || !X.has('rewardCount') || !(n > 0)) return;
      let count = n;
      const ev = { count: n, ...info(self) };
      for (const r of answers('rewardCount', ev)) if (Number.isFinite(r)) count = ev.count = Math.max(1, Math.min(Math.floor(r), 12));
      st.count++; st.last.count = [n, count];
      if (count !== n) return { value: count };
    });
  });

  // ---------------------------------------------------------------------------------------------------------
  // teamLuck: points added to the party's luck (the game's 0..14 scale, D..SSS) wherever the game uses it:
  // rarity upgrades of reward options, the letter on the reward screen, the rarity of wild Pokémon.
  // The game's function (getPartyLuckValue) cannot be reached; it adds up getLuck() of every party member that
  // may battle and clamps the sum to 0..14. So for the length of one call one such member answers getLuck()
  // with the bonus on top (an own property on that one object, deleted again in `finally`). Nothing is
  // written to any Pokémon's luck field. A daily run takes its luck from the day's seed: left alone.
  function luckBonus() {
    if (!X.has('teamLuck') || isDaily()) return 0;
    let n = 0;
    for (const r of answers('teamLuck', { wave: B.wave() })) if (Number.isFinite(r)) n += r;
    return Math.max(0, Math.min(Math.floor(n), 14));
  }
  let luckDepth = 0;
  function withLuck(fn) {
    let p = null, bonus = 0;
    X.guard('b2 luck', () => {
      if (luckDepth) return;
      bonus = luckBonus();
      if (!(bonus > 0)) return;
      p = scene().getPlayerParty().find(q => q && typeof q.getLuck === 'function' && q.isAllowedInBattle() && !Object.prototype.hasOwnProperty.call(q, 'getLuck')) || null;
    });
    if (!p || !(bonus > 0)) return fn();
    const own = p.getLuck; // the class's method
    luckDepth++; st.luckCalls++; st.last.luck = bonus;
    p.getLuck = function () { return own.apply(this, arguments) + bonus; };
    try { return fn(); } finally { delete p.getLuck; luckDepth--; }
  }
  // the party's luck as the game adds it up (without what a timed event adds), and the same with the mods' points
  const LUCK = ['D', 'C', 'C+', 'B-', 'B', 'B+', 'A-', 'A', 'A+', 'A++', 'S', 'S+', 'SS', 'SS+', 'SSS'];
  function partyLuck() {
    let n = 0;
    for (const p of scene().getPlayerParty()) if (p && p.isAllowedInBattle()) n += p.getLuck();
    return Math.max(0, Math.min(n, 14));
  }
  X.extendBattle({
    // the team's luck right now, mods' points included: { value: 0..14, letter: 'D'..'SSS', bonus }
    teamLuck: () => X.guard('b2 teamLuck', () => {
      const bonus = luckBonus(), value = Math.min(14, partyLuck() + bonus);
      return { value, letter: LUCK[value], bonus };
    }, { value: 0, letter: 'D', bonus: 0 }),
  });

  // SelectModifierPhase.getModifierTypeOptions: wrapped once for the luck and for the mints (addMint, below).
  // Our wrap sits outside host-team.js's (its lure swap rolls the game's list again, with our luck) and inside
  // the core's (its offer of mod items sees our list).
  X.phaseClass('SelectModifierPhase', proto => {
    st.wraps.getModifierTypeOptions = X.wrap(proto, 'getModifierTypeOptions', 'b2', orig => function () {
      const self = this, args = arguments;
      return withLuck(() => {
        const opts = orig.apply(self, args);
        X.guard('b2 mint', () => addMint(self, opts, () => orig.apply(self, args)));
        return opts;
      });
    });
  });
  let sceneDone = null, arenaDone = null;
  function hookLuck(s) {
    if (sceneDone !== s && typeof s.updateAndShowText === 'function') { // the letter on the reward screen
      sceneDone = s;
      st.wraps.updateAndShowText = X.wrap(s, 'updateAndShowText', 'b2', orig => function () { const self = this, args = arguments; return withLuck(() => orig.apply(self, args)); });
    }
    const proto = s.arena && X.protoWith(s.arena, 'randomSpecies');
    if (proto && proto !== arenaDone) {
      arenaDone = proto;
      // randomSpecies(waveIndex, level, attempt = 0, luckValue = 0, isBoss): the callers hand the party's luck in.
      // It calls itself again with attempt + 1 and the same luck when it rolls again: only the first call adds.
      st.wraps.randomSpecies = X.before(proto, 'randomSpecies', 'b2', (self, args) => {
        if (args.length < 4 || args[2]) return; // no luck passed (幻觉 picks a species this way), or a retry
        const bonus = luckBonus();
        if (!(bonus > 0)) return;
        const next = args.slice();
        next[3] = Math.min(14, (Number(args[3]) || 0) + bonus);
        st.luckSpecies++; st.last.species = [args[3], next[3]];
        return { args: next };
      });
    }
  }

  // ---------------------------------------------------------------------------------------------------------
  // mintRate: how many times as often a mint (薄荷) comes up among the reward options.
  // The game's pools and weights cannot be reached. Instead: when the screen the game rolled has no mint, the
  // same screen is rolled once more out of sight (on a seed of its own; the game's random sequence is put back
  // afterwards), and a mint found there is let through with chance (rate - 1). It takes the place of the
  // cheapest option of the real screen that is not above a mint's rarity (高级). The hidden roll is the game's
  // own roll, so it finds a mint exactly as often as the real one: a screen has a mint `rate` times as often
  // (less the rare case that both rolls had one). Only the normal reward and its rerolls; never a set list or
  // a copy of a screen. The game never puts two mints on one screen, and neither do we.
  const isMint = o => !!(o && o.type && (o.type.id === 'MINT' || (o.type.constructor && o.type.constructor.name === 'PokemonNatureChangeModifierType')));
  function mintRate(ph) {
    if (dbg.mintRate != null) return dbg.mintRate;
    let rate = 1;
    for (const r of answers('mintRate', info(ph))) if (Number.isFinite(r) && r > 0) rate *= r;
    return rate;
  }
  function addMint(ph, opts, rollAgain) {
    if (ph.customModifierSettings || ph.isCopy || !Array.isArray(opts) || !opts.length) return;
    if (dbg.mintRate == null && !X.has('mintRate')) return;
    if (opts.some(isMint)) return;
    const extra = Math.min(mintRate(ph) - 1, 50);
    if (!(extra > 0)) return;
    const s = scene(), wave = B.wave(), rc = ph.rerollCount || 0;
    const lock = !!(s.lockModifierTiers && ph.modifierTiers && ph.modifierTiers.length);
    const tierOf = o => (o && o.type ? o.type.tier || 0 : 99);
    // the slot a mint may take: an option of 高级 or below (never a rarer one, never a mod item); with 锁定稀有度
    // on only a 高级 one, because the rarities on screen are what the next reroll keeps and what it costs
    let at = -1;
    opts.forEach((o, i) => {
      if (!o || !o.type || o.type.__coopMod) return;
      const t = tierOf(o);
      if ((lock ? t === 2 : t <= 2) && (at < 0 || t < tierOf(opts[at]))) at = i;
    });
    if (at < 0) return;
    const k = Math.ceil(extra), chance = extra / k; // k hidden screens, each lets its mint through with extra / k
    const roll = X.rng([s.seed, wave, rc, 'b2-mint'].join(':'));
    let mint = null;
    for (let j = 0; j < k && !mint; j++) {
      const r = roll();
      let found = null;
      s.executeWithSeedOffset(() => { // an error inside would leave the game's random state changed: caught here
        try { found = (rollAgain() || []).find(isMint) || null; } catch (e) { X.log('b2 mint: hidden roll failed: ' + String(e).slice(0, 200)); }
      }, 7919 * (wave + 1) + 131 * rc + j);
      st.shadows++;
      if (!found) continue;
      st.mintsFound++;
      if (r < chance) mint = found;
    }
    if (!mint) return;
    const was = opts[at];
    opts[at] = mint;
    st.mintsPut++; st.last.mint = { wave, rc, at, was: was.type && was.type.id, mint: mint.type.name };
    X.log('b2 mint: ' + mint.type.name + ' takes slot ' + at + ' (wave ' + wave + ', reroll ' + rc + ')');
  }

  // ---------------------------------------------------------------------------------------------------------
  // ballThrown: a Poké Ball was thrown (AttemptCapturePhase.start took it out of the pouch). A listener that
  // returns true keeps the ball: it is put back inside the same call. A throw at a Pokémon that is already
  // gone takes no ball and is not reported.
  // Whose pouch: host-team.js gives each player their own balls and shows the game one pouch (a view that
  // goes by the current phase). At this moment its idea of the thrower (CoopTeam.catcher(), filled by a
  // 150 ms poll) is usually still empty or the thrower of an earlier turn, so the ball may have come out of
  // the other player's pouch (seen on the rig: 2P throws, 1P's count drops). We do not judge that: the ball
  // goes back into the very pouch it was taken from. For that write the phase manager answers
  // "a CommandPhase of that player's Pokémon" to host-team.js's question (its rule: a Pokémon choosing its
  // command is its owner's business); afterwards the pouches are compared with how they were before the throw.
  const Team = () => window.CoopTeam || null;
  const pouches = () => { const T = Team(); return T && typeof T.purse === 'function' ? T.purse().balls : null; };
  function thrower() { // the player whose Pokémon has this turn's BALL command (the other slot carries a skipped copy)
    const s = scene(), b = s.currentBattle, party = s.getPlayerParty(), T = Team();
    if (!b || !b.turnCommands || !T) return null;
    for (const slot of [0, 1]) { const c = b.turnCommands[slot]; if (c && c.command === 1 /* Command.BALL */ && !c.skip) return T.ownerOf(party[slot]) || null; }
    return null;
  }
  function asPlayer(who, fn) { // run fn while host-team.js sees `who` as the one acting
    const s = scene(), pm = s.phaseManager, T = Team();
    const i = s.getPlayerParty().findIndex(p => T.ownerOf(p) === who);
    if (i < 0) return false;
    const own = Object.prototype.hasOwnProperty.call(pm, 'getCurrentPhase'), was = pm.getCurrentPhase;
    pm.getCurrentPhase = () => ({ phaseName: 'CommandPhase', fieldIndex: i });
    try { if (T.actor() !== who) return false; fn(); return true; } finally { if (own) pm.getCurrentPhase = was; else delete pm.getCurrentPhase; }
  }
  function putBack(t, before, p0) {
    const s = scene(), p1 = pouches();
    const n = (box, who) => (box && box[who] && Number(box[who][t])) || 0;
    const lost = p0 && p1 ? ['p1', 'p2'].filter(w => n(p1, w) === n(p0, w) - 1) : [];
    let how = 'view';
    if (lost.length === 1 && n(p0, 'p1') + n(p0, 'p2') === n(p1, 'p1') + n(p1, 'p2') + 1 && asPlayer(lost[0], () => { s.pokeballCounts[t] = s.pokeballCounts[t] + 1; })) how = lost[0];
    else s.pokeballCounts[t] = before; // no split pouches to look at: the game's own pouch, as it was
    const p2 = pouches(), same = !p0 || !p2 || (n(p0, 'p1') === n(p2, 'p1') && n(p0, 'p2') === n(p2, 'p2'));
    if (!same) X.log('b2 ball: the ball is back, but not in the pouch it came from: ' + JSON.stringify([p0, p1, p2].map(x => [n(x, 'p1'), n(x, 'p2')])));
    return { how, same };
  }
  X.phaseClass('AttemptCapturePhase', proto => {
    st.wraps.captureStart = X.wrap(proto, 'start', 'b2', orig => function () {
      const self = this, s = scene(), t = self.pokeballType;
      let before = null, p0 = null;
      if (X.has('ballThrown')) X.guard('b2 ball (before)', () => { p0 = pouches(); before = s.pokeballCounts[t]; });
      const r = orig.apply(self, arguments);
      if (before != null) X.guard('b2 ball (after)', () => {
        const after = s.pokeballCounts[t];
        if (after !== before - 1) return; // no ball was taken (the target is gone), or somebody else changed the count
        const owner = thrower();
        st.throws++;
        const keep = answers('ballThrown', { ball: t, owner, wave: B.wave() }).some(x => x === true);
        st.last.ball = { ball: t, owner, catcher: (Team() && Team().catcher && Team().catcher()) || null, before, after, keep };
        if (!keep) return;
        const back = putBack(t, before, p0);
        self.__b2Kept = true;
        st.kept++; st.last.ball.back = back;
        X.log('b2 ball: kept (kind ' + t + ', thrown by ' + owner + ', back to ' + back.how + ')');
      });
      return r;
    });
    // 捡球 (Ball Fetch) hands the last ball of a failed throw back at the end of the turn: not a second time
    // when the ball was never used up
    st.wraps.failCatch = X.after(proto, 'failCatch', 'b2', self => {
      if (!self.__b2Kept) return;
      const b = scene().currentBattle;
      if (b && b.lastUsedPokeball === self.pokeballType) { b.lastUsedPokeball = null; st.last.fetchCleared = true; }
    });
  });

  // ---------------------------------------------------------------------------------------------------------
  // A mod switched on or off while a reward screen is open: the price under 刷新商店 and the luck letter were
  // written when the screen opened, and would go on showing 免费×N (or the old ₽ price, or the old letter)
  // although the next press costs something else. Ask the game again and write both anew. Done at the switch
  // itself (switching the last mod off stops the ticks) and on the next ticks (switching the first mod on puts
  // the hooks in at the next tick only). Nothing is rolled again: the options on screen stay as they are.
  let stale = 0;
  function refreshShown(s) {
    const pm = s && s.phaseManager, ph = pm && pm.getCurrentPhase(), h = s && s.ui && typeof s.ui.getHandler === 'function' ? s.ui.getHandler() : null;
    if (!ph || ph.phaseName !== 'SelectModifierPhase' || !Array.isArray(ph.typeOptions)) return false;
    if (!h || !h.constructor || h.constructor.name !== 'ModifierSelectUiHandler' || !h.active) return false; // a party menu or a question is on top: the game writes the price again when it comes back
    if (typeof h.setRerollCost !== 'function' || typeof h.updateRerollCostText !== 'function') return false;
    h.setRerollCost(ph.getRerollCost(s.lockModifierTiers));
    h.updateRerollCostText();
    if (s.luckText && s.luckText.visible && typeof s.updateAndShowText === 'function') s.updateAndShowText(0);
    st.refreshed = (st.refreshed || 0) + 1;
    return true;
  }
  X.onSwitch(() => { stale = 3; X.guard('b2 refresh (switch)', () => refreshShown(scene())); });

  X.onTick(s => { hookLabel(s); hookLuck(s); if (stale > 0) { stale--; X.guard('b2 refresh (tick)', () => refreshShown(s)); } });

  // ---- tests (rigs/b2): CoopMods.debug.b2(), .b2Set({ mintRate }) ----
  X.debug('b2', () => JSON.parse(JSON.stringify({ ...st, freeUsed: chain.free, chain, dbg, luck: X.guard('b2 dbg', () => B.teamLuck(), null) })));
  X.debug('b2Set', o => { Object.assign(dbg, o || {}); return { ...dbg }; });
  X.debug('b2IsMint', isMint);
});
