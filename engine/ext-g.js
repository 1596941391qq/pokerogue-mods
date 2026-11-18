// Engine extension g (接口版本 3): what a difficulty mod needs, in solo games and in co-op rooms alike.
// Asked for by B 站 Chess_大概是屑 & 深溟Ming (GitHub Chess12333), whose 进阶 (ascension) fork of the desktop build
// changed the game directly; the native option list on the starter screen, its description box, the corner
// label with its hover list and the labels on the save slots are their design, taken over from that fork.
//
//   limits (asked by the patched game through window.PRS_*; see scripts/patch-coop.mjs / patch-web.mjs)
//     event partyMax       how many Pokémon a player may have            {max}            -> 1..6
//     event starterMax     how many starters may be picked               {max}            -> 1..6
//     event starterPoints  the starter points of a classic run           {points}         -> 1..20
//     event rewardOdds     how often a reward slot is 超级 / 高级 / 肉鸽  {great, ultra, rogue} of 1024 -> {great?, ultra?, rogue?}
//   numbers of the run
//     event moneyGain      money about to be won (battle, money items)   {amount, wave, source}   -> number
//     event expGain        experience about to be given to one Pokémon   {pokemon, amount}        -> number
//     event partyHeal      the free full heal between areas, per Pokémon {pokemon, before, hp, maxHp} -> hp it ends with
//     event reviveHp       a revive (复活种子, 活力碎片 ...) is about to restore HP {pokemon, amount, source} -> number
//   encounters
//     event bossWave       is this wave a boss wave                      {wave, boss}     -> true
//     event bossSegments   how many bars a boss has                      {wave, segments} -> 1..10
//     event wildBiome      a wild Pokémon is about to be drawn           {wave, biome, random()} -> true | biome id
//     event itemAllowed    may this game item be offered / obtained      {id, name, tier, where}  -> false
//   a choice per run
//     api.runSetup(def)    a list shown once on the starter screen of a new game; the choice is kept in the run's
//                          save, shown in the corner during battle and on the save slots, and can be changed from
//                          the list of mods. api.runValue() reads it.
// Every "ask" event is asked of each listener in turn; a listener sees what the one before answered.
CoopModsExt('g', X => {
  const { scene, log, guard, el } = X;
  const num = x => typeof x === 'number' && isFinite(x);
  const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
  const seen = { asks: {}, last: {}, partyHeal: 0, revive: 0, migrants: 0, banned: 0, picker: 0 }; // counters for tests (CoopMods.debug.g())
  ['partyMax', 'starterMax', 'starterPoints', 'rewardOdds', 'moneyGain', 'expGain', 'partyHeal', 'reviveHp', 'bossWave', 'bossSegments', 'wildBiome', 'itemAllowed'].forEach(n => X.addEvent(n));
  // ask every listener; take(answer, ev) folds an answer into ev
  function ask(type, ev, take) {
    if (!X.has(type)) return ev;
    seen.asks[type] = (seen.asks[type] || 0) + 1;
    const nums = () => Object.fromEntries(Object.keys(ev).filter(k => typeof ev[k] !== 'object' && typeof ev[k] !== 'function').map(k => [k, ev[k]]));
    const was = nums();
    for (const [m, fn] of X.listeners(type)) { const r = guard('mod ' + m.id + ' ' + type, () => fn(ev)); if (r !== undefined && r !== null) guard(type + ' answer', () => take(r, ev)); }
    seen.last[type] = [was, nums()];
    return ev;
  }
  const waveNow = () => guard('g wave', () => (scene().currentBattle || {}).waveIndex || 0, 0);

  // ---- limits: the patched game asks these; without the patch (an older package) nothing asks ----
  const limit = (type, key, dflt, lo, hi) => guard('g ' + type, () => ask(type, { [key]: dflt }, (r, ev) => { if (num(r)) ev[key] = clamp(Math.floor(r), lo, hi); })[key], dflt);
  const partyMax = () => limit('partyMax', 'max', 6, 1, 6);
  const starterMax = () => limit('starterMax', 'max', 6, 1, 6);
  window.PRS_PARTY_MAX = partyMax;       // a player's party is full at this many (host-team.js asks it per player)
  window.PRS_STARTER_MAX = starterMax;
  window.PRS_POINTS = () => limit('starterPoints', 'points', 10, 1, 20);
  // The game rolls 0..1023 per reward slot: 0 = 大师, 1..T0 = 肉鸽, ..T1 = 高级, ..T2 = 超级, the rest 普通
  // (T0 12, T1 60, T2 255). The event speaks in counts out of 1024: rogue 12, ultra 48, great 195.
  const ODDS = { great: 195, ultra: 48, rogue: 12 };
  function odds() {
    const ev = ask('rewardOdds', { ...ODDS }, (r, e) => {
      if (!r || typeof r !== 'object') return;
      for (const k of Object.keys(ODDS)) if (num(r[k])) e[k] = clamp(Math.floor(r[k]), 0, 1023);
    });
    if (ev.great + ev.ultra + ev.rogue > 1023) return { ...ODDS }; // more than there is: the answer is dropped
    return ev;
  }
  window.PRS_T = i => guard('g rewardOdds', () => { const o = odds(); return i === 2 ? o.rogue + o.ultra + o.great : i === 1 ? o.rogue + o.ultra : o.rogue; }, i === 2 ? 255 : i === 1 ? 60 : 12);

  // ---- money ----
  // scene.getWaveMoneyAmount is the base of prices as well as of winnings: the event is only asked while money
  // is being handed out (the battle's reward phase, a money item being used).
  let gaining = null; // 'battle' | 'item'
  X.phaseClass('MoneyRewardPhase', proto => {
    X.wrap(proto, 'start', 'g', orig => function () { const was = gaining; gaining = 'battle'; try { return orig.apply(this, arguments); } finally { gaining = was; } });
  });
  let sceneProto = null;
  function hookScene(s) {
    const proto = X.protoWith(s, 'getWaveMoneyAmount');
    if (!proto || proto === sceneProto) return;
    sceneProto = proto;
    X.after(proto, 'getWaveMoneyAmount', 'g', (self, args, res) => {
      if (!gaining || !num(res)) return;
      const ev = ask('moneyGain', { amount: res, wave: waveNow(), source: gaining }, (r, e) => { if (num(r)) e.amount = Math.max(0, Math.floor(r)); });
      return ev.amount === res ? undefined : { value: ev.amount };
    });
    // bosses: a wave a mod calls a boss wave has a boss (two bars) where the game had none
    X.after(proto, 'getEncounterBossSegments', 'g', (self, args, res) => {
      if (!num(res)) return;
      let n = res;
      const wave = args[0];
      if (n === 0 && bossWave(wave, false)) n = 2;
      if (n > 0) n = ask('bossSegments', { wave, segments: n }, (r, e) => { if (num(r)) e.segments = clamp(Math.floor(r), 1, 10); }).segments;
      return n === res ? undefined : { value: n };
    });
    // items: one a mod forbids is not obtained (wherever it comes from); a money item counts as winnings
    X.wrap(proto, 'addModifier', 'g', orig => function (modifier) {
      const t = modifier && modifier.type;
      if (t && !t.__coopMod && !allowed(t, 'gain')) { seen.banned++; log('g: ' + (t.id || t.name) + ' not obtained (a mod forbids it)'); return false; }
      if (!medProto) guard('g medicine class', () => hookMedicine(modifier)); // the first HP medicine gives its class away (for reviveHp)
      const money = !!(modifier && modifier.constructor && modifier.constructor.name === 'MoneyRewardModifier');
      if (!money) return orig.apply(this, arguments);
      const was = gaining; gaining = 'item';
      try { return orig.apply(this, arguments); } finally { gaining = was; }
    });
  }
  const bossWave = (wave, boss) => !!ask('bossWave', { wave, boss: !!boss }, (r, e) => { if (r === true) e.boss = true; }).boss;
  let modeProto = null;
  function hookGameMode(s) {
    const proto = s.gameMode && X.protoWith(s.gameMode, 'isTrainerBoss');
    if (!proto || proto === modeProto) return;
    modeProto = proto;
    X.after(proto, 'isTrainerBoss', 'g', (self, args, res) => (!res && bossWave(args[0], false) ? { value: true } : undefined));
  }

  // ---- experience ----
  const expStart = self => {
    if (!num(self.expValue) || !(self.expValue > 0)) return;
    const p = guard('g exp pokemon', () => self.getPokemon(), null);
    const ev = ask('expGain', { pokemon: p, amount: self.expValue }, (r, e) => { if (num(r)) e.amount = Math.max(0, Math.floor(r)); });
    if (ev.amount !== self.expValue) self.expValue = ev.amount;
  };
  X.phaseClass('ExpPhase', proto => { X.before(proto, 'start', 'g', expStart); });
  X.phaseClass('ShowPartyExpBarPhase', proto => { X.before(proto, 'start', 'g', expStart); });

  // ---- the free full heal between areas (PartyHealPhase sets everybody's HP to the maximum) ----
  X.phaseClass('PartyHealPhase', proto => {
    X.before(proto, 'start', 'g', self => { self.__gBefore = scene().getPlayerParty().map(p => ({ p, hp: p.hp })); });
    X.before(proto, 'end', 'g', self => {
      const was = self.__gBefore; self.__gBefore = null;
      if (!was || !X.has('partyHeal')) return;
      for (const w of was) {
        const p = w.p, max = p.getMaxHp();
        if (!(p.hp > w.hp)) continue; // not healed (a challenge kept it down, or it was full)
        const ev = ask('partyHeal', { pokemon: p, before: w.hp, hp: p.hp, maxHp: max }, (r, e) => { if (num(r)) e.hp = Math.floor(r); });
        const hp = clamp(ev.hp, Math.max(1, w.hp), max);
        if (hp !== p.hp) { p.hp = hp; seen.partyHeal++; guard('g partyHeal info', () => p.updateInfo(true)); }
      }
    });
  });

  // ---- revives: 复活种子 (a heal phase marked revive) and the revive medicines of the reward screen ----
  X.phaseClass('PokemonHealPhase', proto => {
    X.before(proto, 'start', 'g', self => {
      if (!self.revive || !num(self.hpHealed) || !X.has('reviveHp')) return;
      const p = guard('g revive pokemon', () => self.getPokemon(), null);
      const ev = ask('reviveHp', { pokemon: p, amount: self.hpHealed, source: 'seed' }, (r, e) => { if (num(r)) e.amount = Math.max(1, Math.floor(r)); });
      if (ev.amount !== self.hpHealed) { self.hpHealed = ev.amount; seen.revive++; }
    });
  });
  let medProto = null;
  function hookMedicine(modifier) { // PokemonHpRestoreModifier.prototype, from the first one the game uses
    const proto = modifier && Object.getPrototypeOf(modifier);
    if (!proto || proto === medProto || typeof proto.apply !== 'function' || !('restorePercent' in modifier && 'fainted' in modifier)) return;
    medProto = proto;
    X.wrap(proto, 'apply', 'g', orig => function (pokemon) {
      const revive = !!this.fainted && pokemon && !(pokemon.hp > 0);
      const r = orig.apply(this, arguments);
      if (revive && r && pokemon.hp > 0) guard('g revive medicine', () => {
        const ev = ask('reviveHp', { pokemon, amount: pokemon.hp, source: 'item' }, (a, e) => { if (num(a)) e.amount = Math.max(1, Math.floor(a)); });
        if (ev.amount < pokemon.hp) { pokemon.hp = ev.amount; seen.revive++; }
      });
      return r;
    });
  }

  // ---- wild Pokémon of another area ----
  let arenaProto = null;
  const pools = {}; // biome id -> its pokemonPool (null: no such biome)
  const BIOMES = [...Array.from({ length: 31 }, (_, i) => i + 1), 40, 41]; // every area but the starting town (0) and the end (50)
  const draws = { key: '', n: 0 };
  function hookArena(s) {
    const ar = s.arena, proto = ar && X.protoWith(ar, 'randomSpecies');
    if (!proto || proto === arenaProto) return;
    arenaProto = proto;
    const poolOf = (self, id) => {
      if (!(id in pools)) pools[id] = guard('g biome pool', () => { const a = new self.constructor(id); return a && a.pokemonPool ? a.pokemonPool : null; }, null);
      return pools[id];
    };
    X.wrap(proto, 'randomSpecies', 'g', orig => function (waveIndex, level, attempt) {
      if (attempt || !X.has('wildBiome')) return orig.apply(this, arguments); // (a retry of the same draw stays in the pool it was drawn from)
      let pool = null;
      guard('g wildBiome', () => {
        const key = scene().seed + ':' + waveIndex;
        if (draws.key !== key) { draws.key = key; draws.n = 0; }
        const roll = X.rng(key + ':wild:' + draws.n++);
        const ev = ask('wildBiome', { wave: waveIndex, biome: this.biomeId, random: roll, to: null }, (r, e) => { if (r === true || num(r)) e.to = r; });
        if (ev.to == null) return;
        if (ev.to === true) { for (let k = 0; k < 6 && !pool; k++) { const id = BIOMES[Math.floor(roll() * BIOMES.length)]; if (id !== this.biomeId) pool = poolOf(this, id); } }
        else if (ev.to !== this.biomeId) pool = poolOf(this, Math.floor(ev.to));
      });
      if (!pool) return orig.apply(this, arguments);
      const keep = this.pokemonPool;
      this.pokemonPool = pool; seen.migrants++;
      try { return orig.apply(this, arguments); } finally { this.pokemonPool = keep; }
    });
  }

  // ---- game items a mod forbids ----
  const TIER_NAMES = ['COMMON', 'GREAT', 'ULTRA', 'ROGUE', 'MASTER'];
  function allowed(type, where) {
    if (!X.has('itemAllowed')) return true;
    const id = String(type.id || String(type.localeKey || '').split('.').pop() || '');
    return ask('itemAllowed', { id, name: String(type.name || ''), tier: TIER_NAMES[type.tier] || null, where, ok: true }, (r, e) => { if (r === false) e.ok = false; }).ok;
  }
  X.onRewardOptions((ph, opts) => {
    if (!X.has('itemAllowed')) return;
    const kept = opts.filter(o => !o || !o.type || o.type.__coopMod || allowed(o.type, 'reward'));
    if (kept.length === opts.length || !kept.length) return; // (never an empty screen)
    seen.banned += opts.length - kept.length;
    return kept;
  });

  // ---- a choice per run: api.runSetup ----
  const setups = {}; // mod id -> { options, dflt, badge, detail, title }
  const REMEMBER = 'coop-mods-setup-v1';
  const remembered = () => { try { const o = JSON.parse(localStorage.getItem(REMEMBER) || '{}'); return o && typeof o === 'object' ? o : {}; } catch { return {}; } };
  const remember = (id, v) => { try { const o = remembered(); o[id] = v; localStorage.setItem(REMEMBER, JSON.stringify(o)); } catch {} };
  const optionsOf = id => { const d = setups[id]; const list = guard('runSetup options ' + id, () => (typeof d.options === 'function' ? d.options() : d.options), []); return (Array.isArray(list) ? list : []).filter(o => o && o.label != null).map(o => ({ value: o.value, label: String(o.label), description: o.description == null ? '' : String(o.description) })); };
  const valid = (id, v) => optionsOf(id).some(o => o.value === v);
  const valueOf = id => { const d = setups[id]; if (!d) return null; const st = X.runState(id); return 'setup' in st && valid(id, st.setup) ? st.setup : d.dflt; };
  function setValue(id, v, why) {
    if (!setups[id] || !valid(id, v)) return false;
    X.runState(id).setup = v;
    remember(id, v);
    hud.sig = '';
    log('g: ' + id + ' run setup = ' + JSON.stringify(v) + ' (' + why + ')');
    guard('runSetup changed ' + id, () => setups[id].changed && setups[id].changed(v));
    return true;
  }
  const liveSetups = () => X.order.filter(id => setups[id] && X.isOn(id));
  const badgeOf = (id, v) => guard('runSetup badge ' + id, () => { const t = setups[id].badge ? setups[id].badge(v) : ''; return typeof t === 'string' ? t.slice(0, 16) : ''; }, '');
  const detailOf = (id, v) => guard('runSetup detail ' + id, () => { const t = setups[id].detail ? setups[id].detail(v) : []; return (Array.isArray(t) ? t : [t]).filter(x => typeof x === 'string' && x).slice(0, 12).map(x => x.slice(0, 20)); }, []);
  X.extendApi(mod => ({
    runSetup(def) {
      if (setups[mod.id]) throw new Error('runSetup: one per mod');
      if (!def || !(Array.isArray(def.options) || typeof def.options === 'function')) throw new Error('runSetup needs options: [{ value, label, description }]');
      setups[mod.id] = { options: def.options, dflt: def.default === undefined ? null : def.default, badge: typeof def.badge === 'function' ? def.badge : null,
        detail: typeof def.detail === 'function' ? def.detail : null, changed: typeof def.changed === 'function' ? def.changed : null, title: String(def.title || mod.manifest.name || mod.id) };
    },
    runValue: () => valueOf(mod.id),
  }));
  // a new game's starter screen opens: every choice starts from what was chosen last time on this device
  let asked = null; // the mods whose list has been shown on this starter screen
  X.onSetup(() => {
    asked = new Set();
    for (const id of Object.keys(setups)) { const r = remembered()[id]; if (r !== undefined && valid(id, r)) X.runState(id).setup = r; }
  });

  // the game's own windows: any nine-slice drawn with a window_* texture tells which skin the player uses
  function findWindow(s) {
    let hit = null;
    const consider = o => { if (!hit && o && o.type === 'NineSlice' && o.texture && /^window_/.test(o.texture.key) && o.leftWidth > 0) hit = o; };
    const walk = (list, depth) => { if (!list || depth > 6) return; for (let i = 0; i < list.length && !hit; i++) { const o = list[i]; if (!o) continue; consider(o); if (o.list) walk(o.list, depth + 1); } };
    guard('g find window', () => walk(s.children.list, 0));
    if (!hit) guard('g find window (ui)', () => { for (const h of (s.ui && s.ui.handlers) || []) { const c = h && h.container; if (!c || hit) continue; consider(c); if (c.list) walk(c.list, 1); } });
    return hit;
  }
  function box(s, x, y, w, h) {
    const src = findWindow(s);
    return s.add.nineslice(x, y, src ? src.texture.key : 'window_1', src && src.frame ? src.frame.name : undefined, w, h, 8, 8, 8, 8).setOrigin(0);
  }
  const words = (s, x, y, str, size, color, wrap) => s.add.text(x, y, str, { fontFamily: 'emerald', fontSize: size, color: color || '#f8f8f8', padding: { bottom: 6 }, wordWrap: wrap ? { width: wrap * 6, useAdvancedWrap: true } : undefined })
    .setScale(1 / 6).setShadow(3, 4, '#0b0910', 0, false, true);
  // the description box under the list (world is 320x180, drawn 6x)
  const desc = { layer: null, text: null };
  function showDesc(s, str) {
    guard('g desc', () => {
      if (!desc.layer || !desc.layer.scene) {
        // left of the option list (which grows from the right edge with its longest label), along the bottom
        let left = 176;
        guard('g desc width', () => { const h = s.ui.getHandler(), bg = h && h.optionSelectBg; if (bg && bg.getBounds) { const x = Math.floor(bg.getBounds().x / 6); if (x > 60 && x < 320) left = x; } });
        const w = clamp(left - 7, 80, 208);
        desc.layer = s.add.container(0, 0).setScale(6).setDepth(1e6 - 2).setName('coop-mods-setup-desc');
        desc.layer.add(box(s, 4, 122, w, 52));
        desc.text = words(s, 12, 128, '', 54, '#f8f8f8', w - 16).setLineSpacing(8);
        desc.layer.add(desc.text);
      }
      desc.text.setText(str || '');
    });
  }
  const hideDesc = () => guard('g desc off', () => { if (desc.layer) { if (desc.layer.scene) desc.layer.destroy(); desc.layer = null; desc.text = null; } });
  const handlerNo = (s, name) => (s.ui.handlers || []).findIndex(h => h && h.constructor && h.constructor.name === name);
  // the game's own option list over the starter screen: its frame, cursor and keys. The last entry keeps things
  // as they are (the game picks the last entry when the cancel key is pressed).
  function openPicker(s, id, back) {
    const ui = s.ui, listMode = handlerNo(s, 'OptionSelectUiHandler'), d = setups[id];
    if (listMode < 0 || typeof ui.setModeWithoutClear !== 'function') return false;
    const NL = '\n', opts = optionsOf(id);
    if (!opts.length) return false;
    const cur = valueOf(id), curOpt = opts.find(o => o.value === cur);
    const done = v => { hideDesc(); if (v !== undefined) setValue(id, v, 'starter screen'); ui.setMode(back); return true; };
    const list = opts.map(o => ({ label: o.label, onHover: () => showDesc(s, o.description), handler: () => done(o.value) }));
    list.push({ label: '保持不变', onHover: () => showDesc(s, d.title + '：' + (curOpt ? curOpt.label : '默认') + NL + '不改，保持现在的选择。'), handler: () => done(undefined) });
    ui.setModeWithoutClear(listMode, { options: list, maxOptions: 6 });
    seen.picker++;
    log('g: run setup list of ' + id + ' opened');
    return true;
  }
  function tickSetup(s) {
    const h = guard('g handler', () => (s.ui ? s.ui.getHandler() : null), null);
    const starter = !!(h && h.constructor && h.constructor.name === 'StarterSelectUiHandler');
    if (!starter) { if (!(h && h.constructor && h.constructor.name === 'OptionSelectUiHandler')) hideDesc(); return; }
    // the starter screen is up: at most starterMax starters (the row of slots is drawn for six when the game boots)
    guard('g starter slots', () => {
      const max = starterMax();
      if (Array.isArray(h.partyStarterIds) && typeof h.popPartyStarter === 'function') { let n = 0; while (h.partyStarterIds.length > max && n++ < 12) h.popPartyStarter(h.partyStarterIds.length - 1); }
      if (Array.isArray(h.partyIcons)) h.partyIcons.forEach((ic, i) => { if (ic && ic.visible !== (i < max)) ic.setVisible(i < max); });
      const pts = window.PRS_POINTS();
      if (h.__gPoints !== pts && typeof h.tryUpdateValue === 'function') { h.__gPoints = pts; h.tryUpdateValue(0); }
    });
    if (!X.inSetup() || !asked) return;
    const next = liveSetups().find(id => !asked.has(id));
    if (!next) return;
    asked.add(next);
    guard('g picker', () => openPicker(s, next, handlerNo(s, 'StarterSelectUiHandler')));
  }

  // the label during a run (what was chosen), under the money at the top right, with the list of what it means
  // on hover / touch. Only while a battle screen is up (the reward screen writes the team's luck in that place).
  const hud = { scene: null, layer: null, sig: '' };
  const HUD_MODES = ['COMMAND', 'FIGHT', 'TARGET_SELECT', 'BALL', 'MESSAGE'];
  function tickHud(s) {
    if (!window.Phaser || !s.add) return;
    const ids = liveSetups();
    const inRun = !!(s.currentBattle && s.currentBattle.waveIndex) && !X.inSetup() && HUD_MODES.includes(X.uiMode());
    const parts = inRun ? ids.map(id => ({ id, v: valueOf(id) })).map(x => ({ ...x, badge: badgeOf(x.id, x.v) })).filter(x => x.badge) : [];
    // where: right edge and bottom of the money text (it moves down when the enemies' item bar is there)
    let right = 318, top = 22;
    if (parts.length) guard('g hud place', () => { const m = s.moneyText; if (m && m.getBounds) { const r = m.getBounds(); if (r.width > 0) { right = Math.round((r.x + r.width) / 6); top = Math.round((r.y + r.height) / 6) + 1; } } });
    const sig = parts.length ? parts.map(x => x.badge).join('|') + '@' + right + ',' + top : '';
    if (s !== hud.scene || !hud.layer || !hud.layer.scene || s.children.getIndex(hud.layer) < 0) {
      guard('g hud off', () => { if (hud.layer && hud.layer.scene) hud.layer.destroy(); });
      hud.scene = s; hud.layer = null; hud.sig = null;
    }
    if (sig === hud.sig) return;
    hud.sig = sig;
    if (hud.layer) { hud.layer.destroy(); hud.layer = null; }
    if (!parts.length) return;
    hud.layer = s.add.container(0, 0).setScale(6).setDepth(1e6 - 2).setName('coop-mods-run-label');
    const label = words(s, right, top, parts.map(x => x.badge).join(' · '), 54, '#f5c84c').setOrigin(1, 0);
    hud.layer.add(label);
    const lines = [].concat(...parts.map(x => detailOf(x.id, x.v)));
    if (lines.length) guard('g hud tip', () => {
      const w = 84, h = 11 + lines.length * 9;
      const tip = s.add.container(right - w, top + 11);
      tip.add(box(s, 0, 0, w, h));
      tip.add(words(s, 6, 5, lines.join('\n'), 48, '#f8f8f8').setLineSpacing(6));
      tip.setVisible(false);
      hud.layer.add(tip);
      label.setInteractive({ useHandCursor: true });
      label.on('pointerover', () => tip.setVisible(true));
      label.on('pointerout', () => tip.setVisible(false));
    });
  }
  // the save slots: each run's choice next to it
  function tickSlots(s) {
    const h = guard('g handler', () => (s.ui ? s.ui.getHandler() : null), null);
    if (!h || !Array.isArray(h.sessionSlots)) return;
    const ids = liveSetups();
    h.sessionSlots.forEach(slot => {
      if (!slot || typeof slot.add !== 'function') return;
      let t = slot.getData ? slot.getData('coopModsRun') : null;
      const seed = slot.saveData && slot.saveData.seed != null ? String(slot.saveData.seed) : null;
      const saved = seed ? X.savedRun(seed) : null;
      const text = saved ? ids.map(id => (saved[id] && valid(id, saved[id].setup) ? badgeOf(id, saved[id].setup) : '')).filter(Boolean).join(' · ') : '';
      if (!t) { if (!text) return; t = words(s, 288, 5, '', 72, '#f5c84c').setOrigin(1, 0); slot.add(t); guard('g slot data', () => slot.setData('coopModsRun', t)); }
      if (t.text !== text) t.setText(text);
      t.setVisible(!!text);
    });
  }
  // the list of mods: this run's choice, changeable there
  X.onPanel((id, render) => {
    if (!setups[id] || !X.wanted(id)) return null;
    const s = scene(), running = X.isOn(id), inRun = !!(s && s.currentBattle && s.currentBattle.waveIndex) || X.inSetup();
    const opts = optionsOf(id), cur = valueOf(id), curOpt = opts.find(o => o.value === cur);
    if (!running) return el('div', { class: 'set' }, [el('div', { class: 'meta', text: setups[id].title + '：这种玩法下不生效。' })]);
    if (!inRun) return el('div', { class: 'set' }, [el('div', { class: 'meta', text: setups[id].title + '：开新游戏、选宝可梦的时候会问你。' })]);
    return el('div', { class: 'set' }, [
      el('div', { text: setups[id].title + '（这一局）：' + (curOpt ? curOpt.label : '默认') }),
      el('div', { class: 'meta', text: curOpt && curOpt.description ? curOpt.description.replace(/\n/g, ' ') : '' }),
      el('div', { class: 'opts' }, opts.map(o => el('button', { class: o.value === cur ? 'sel' : '', text: o.label, onclick: () => { setValue(id, o.value, 'list of mods'); render(); } }))),
    ]);
  });

  X.onTick(s => {
    hookScene(s); hookGameMode(s); hookArena(s);
    tickSetup(s); tickHud(s); tickSlots(s);
  });
  X.onSwitch(() => { hud.sig = null; });

  X.debug('g', () => ({ ...seen, setups: Object.fromEntries(Object.keys(setups).map(id => [id, valueOf(id)])), limits: { partyMax: partyMax(), starterMax: starterMax(), points: window.PRS_POINTS(), t: [0, 1, 2].map(window.PRS_T) }, inSetup: X.inSetup() }));
  X.debug('gSet', (id, v) => setValue(id, v, 'debug'));
});
