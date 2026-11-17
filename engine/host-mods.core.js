// Co-op host, optional part: mods (民间创意工坊). Injected after host-team.js / host-game.js, followed by
// mods-bundle.js (every mod of the package: mods/<id>/mod.json + mod.js + icons/*.png, packed by tools/build-mods.mjs).
// The shipped host-mods.js is this file followed by the engine extensions (engine/ext-*.js), put together by
// tools/assemble.mjs. 接口版本 2; mods written for 接口版本 1 load and behave as before.
// - A mod registers items and handlers through a small interface (docs/MOD-API.md); it never touches the
//   game's own classes. This file and the extensions (engine/EXT.md) are the only places that know where
//   the game is hooked.
// - Mods only run in a co-op room (window.CoopTeam is there) and only while switched on. The switch is per
//   device (localStorage coop-mods-v1). With every mod off, no game method is wrapped except the save reader
//   and writer below, which then pass everything through unchanged.
// - Mod items are NOT game items. A 携带道具 (kind 'held') is on one Pokémon, a 被动增益 (kind 'passive') is
//   in the team bag; both may stack up to the item's max. All of it is kept here and written into the
//   session save as one extra block "coopMods" that the game itself ignores (same idea as host-team.js's
//   "coop" block), plus a copy on this device by run seed. So a save made with mods loads in a build without
//   them (the block is just dropped), and a block of a mod that is off or missing is carried along untouched.
//   Block v2 = { v: 2, held: { pokemonId: { itemKey: { n, s } } }, bag: { itemKey: { n, s } } } (n: how many,
//   s: the item's state). Block v1 = { v: 1, held: { pokemonId: { itemKey: state } } } is still read.
// - Rewards: on the normal 5 选 2 reward screen a slot of the same rarity may be replaced by a mod item (as if
//   the item were one more entry in that rarity's pool); an extension may switch that off (X.cfg.normalOffer)
//   and offer mod items its own way. Picking a held item asks which of your Pokémon holds it; a passive
//   item goes straight into the bag.
// - Icons: a mod may bring its own 32x32 PNGs; they are added to the game's item texture as extra frames, so
//   the reward screen, the plates below and anything else that draws an item by frame name shows them.
// - Shown: item icons next to each player's Pokémon in battle (×n for a stack), names on the party screen, a
//   message when an item triggers. CoopMods.openPanel() is the list of mods with their switches and the bag.
(function () {
  if (window.CoopMods) return; // injected twice (from the menu before a room, then with the room)
  const API_VERSION = 2;
  const log = (...a) => console.log('COOP mods', ...a.map(x => (typeof x === 'string' ? x : JSON.stringify(x))));
  const scene = () => window.PRS_SCENE;
  const uiMode = () => { const t = document.getElementById('touchControls'); return (t && t.dataset.uiMode) || null; };
  const PREF_KEY = 'coop-mods-v1', HELD_KEY = 'coop-mods-held-v1', SAVE_KEY = 'coopMods', HELD_KEPT = 30;
  const TIER = { COMMON: 0, GREAT: 1, ULTRA: 2, ROGUE: 3, MASTER: 4 };
  // what a rarity is called for mod items (issue #2); the colours are the game's own (white, blue, gold, red, purple)
  const TIER_ZH = ['普通道具', '超级道具', '高级道具', '肉鸽道具', '大师道具'], TIER_CSS = ['#d8d8d8', '#6aa9ff', '#f5c84c', '#ff6a5c', '#c58cff'];
  const KIND_ZH = { held: '携带道具', passive: '被动增益' };
  // The game picks a reward in two steps: a rarity, then one entry of that rarity's pool by weight. A mod item
  // is treated as one more entry: chance per slot of its rarity = weight / (total + the mod weights there).
  // total: about what the game's own pool adds up to in a normal run (pokerogue 1.12 pools); cap: the largest
  // weight a mod item may have, so it never shows up more often than the game's own held items of that rarity.
  const POOL = [{ total: 250, cap: 4 }, { total: 200, cap: 4 }, { total: 170, cap: 9 }, { total: 90, cap: 5 }, { total: 80, cap: 14 }];
  const EVENTS = ['damageCalc', 'beforeDamage', 'moveSelect', 'status', 'statChange', 'faint', 'turnStart', 'turnEnd', 'give', 'remove',
    'heal', 'moveUsed', 'battleStart', 'battleEnd']; // the last four are new in 接口版本 2; extensions add more (X.addEvent)
  const STATUS = [null, 'poison', 'toxic', 'paralysis', 'sleep', 'freeze', 'burn'], STATUS_ZH = { poison: '中毒', toxic: '剧毒', paralysis: '麻痹', sleep: '睡眠', freeze: '冰冻', burn: '灼伤' };
  // stats that have stages in battle: name <-> the game's Stat enum (HP is 0 and has no stage)
  const STAT = { atk: 1, def: 2, spatk: 3, spdef: 4, spd: 5, acc: 6, eva: 7 };
  const STAT_NAMES = [null, 'atk', 'def', 'spatk', 'spdef', 'spd', 'acc', 'eva'], STAT_ZH = [null, '攻击', '防御', '特攻', '特防', '速度', '命中率', '闪避率'];
  const statNum = x => (typeof x === 'number' ? (STAT_NAMES[x] ? x : 0) : STAT[x] || 0);
  const statApi = Object.freeze({ ...STAT, names: Object.freeze(STAT_NAMES.slice(1)), battle: Object.freeze(['atk', 'def', 'spatk', 'spdef', 'spd']),
    name: x => STAT_NAMES[statNum(x)] || null, zh: x => STAT_ZH[statNum(x)] || '', num: statNum });

  // ---- the mods of this package, and which are switched on ----
  const mods = {}, order = [], items = {}; // items: 'modId:itemId' -> definition
  const prefs = { on: {} };
  try { const p = JSON.parse(localStorage.getItem(PREF_KEY) || '{}'); if (p && p.on && typeof p.on === 'object') prefs.on = p.on; } catch {}
  const isOn = id => !!mods[id] && mods[id].ok && (id in prefs.on ? !!prefs.on[id] : mods[id].manifest.default === 'on');
  const anyOn = () => order.some(isOn);
  const active = () => !!(window.CoopTeam && scene() && scene().phaseManager); // a co-op room is open
  const partyOf = s => (s && s.getPlayerParty && s.getPlayerParty()) || []; // not there yet while the game boots
  const switchFns = [];
  function setOn(id, on) {
    if (!mods[id]) return false;
    prefs.on[id] = !!on;
    try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch {}
    log('mod ' + id + ' switched ' + (on ? 'on' : 'off'));
    ov.sig = '';
    for (const fn of switchFns) { try { fn(id, isOn(id)); } catch (e) { log('switch handler error', String(e)); } }
    return isOn(id);
  }
  const problems = {};
  function problem(mod, what, e) {
    const n = problems[mod.id] = (problems[mod.id] || 0) + 1;
    if (n <= 20) log('mod ' + mod.id + ' error in ' + what + ': ' + String((e && e.stack) || e).slice(0, 300));
  }
  function manifest(m) {
    if (!m || typeof m.id !== 'string' || !/^[a-z0-9][a-z0-9-]{2,39}$/.test(m.id)) { log('manifest refused: bad id', m && m.id); return false; }
    if (mods[m.id]) return false;
    mods[m.id] = { id: m.id, manifest: m, items: [], on: {}, phase: [], ok: false, error: null, v1: !(Number(m.api) >= 2), once: {} };
    order.push(m.id);
    return true;
  }
  function define(id, setup) {
    const mod = mods[id];
    if (!mod) { log('mod ' + id + ': mod.json missing from the bundle, not loaded'); return; }
    if (mod.ok || mod.error) return;
    try {
      if (Number(mod.manifest.api) > API_VERSION) throw new Error('needs interface v' + mod.manifest.api + ', this game has v' + API_VERSION);
      setup(makeApi(mod));
      mod.ok = true;
      log('mod ' + id + ' v' + mod.manifest.version + ' loaded (' + mod.items.length + ' items, interface v' + (mod.v1 ? 1 : 2) + '), ' + (isOn(id) ? 'on' : 'off'));
    } catch (e) {
      mod.error = String((e && e.stack) || e);
      mod.items.forEach(k => { delete items[k]; });
      mod.items = []; mod.on = {}; mod.phase = [];
      log('mod ' + id + ' failed to load: ' + mod.error.slice(0, 300));
    }
  }

  // ---- a mod's own icons: PNGs of at most 32x32 packed into the bundle as data URIs ----
  // They become extra frames of the game's 'items' texture ('coopmod/<mod id>/<file name>'), so everything
  // that draws an item by frame name (the reward screen, its name box, the plates here) can show them.
  const ICON = 32, iconData = {}; // 'modId/name' -> { uri, img, ok }
  const iconReg = { tex: null, done: new Set(), n: 0 };
  function icons(modId, map) {
    if (!mods[modId] || !map || typeof map !== 'object') return 0;
    let n = 0;
    for (const name of Object.keys(map)) {
      const uri = map[name];
      if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(name) || typeof uri !== 'string' || !uri.startsWith('data:image/png;base64,')) { log('mod ' + modId + ': icon ' + name + ' refused'); continue; }
      const d = iconData[modId + '/' + name] = { uri, img: new Image(), ok: false };
      d.img.onload = () => { d.ok = d.img.width > 0 && d.img.height > 0; iconReg.n++; };
      d.img.onerror = () => { log('mod ' + modId + ': icon ' + name + ' is not a picture the browser can read'); };
      d.img.src = uri;
      n++;
    }
    return n;
  }
  function registerIcons(s) {
    const tm = s.textures;
    if (!tm || !tm.exists('items')) return;
    const tex = tm.get('items');
    if (tex !== iconReg.tex) { iconReg.tex = tex; iconReg.done = new Set(); iconReg.seen = -1; } // (the game made its texture anew)
    if (iconReg.seen === iconReg.n) return; // nothing decoded since the last look
    iconReg.seen = iconReg.n;
    const todo = Object.keys(iconData).filter(k => iconData[k].ok && !iconReg.done.has(k));
    if (!todo.length) return;
    // one sheet for this batch: 32x32 cells, each icon centred in its cell (the game's item frames are 32x32)
    const cols = Math.min(todo.length, 16), sheet = document.createElement('canvas');
    sheet.width = cols * ICON; sheet.height = Math.ceil(todo.length / cols) * ICON;
    const g = sheet.getContext('2d');
    g.imageSmoothingEnabled = false;
    todo.forEach((k, i) => {
      const img = iconData[k].img, f = Math.min(1, ICON / img.width, ICON / img.height);
      const w = Math.max(1, Math.round(img.width * f)), h = Math.max(1, Math.round(img.height * f));
      g.drawImage(img, (i % cols) * ICON + Math.floor((ICON - w) / 2), Math.floor(i / cols) * ICON + Math.floor((ICON - h) / 2), w, h);
    });
    const Source = tex.source[0].constructor; // Phaser.Textures.TextureSource
    tex.source.push(new Source(tex, sheet, sheet.width, sheet.height));
    const si = tex.source.length - 1;
    todo.forEach((k, i) => { tex.add('coopmod/' + k, si, (i % cols) * ICON, Math.floor(i / cols) * ICON, ICON, ICON); iconReg.done.add(k); });
    ov.sig = '';
    log('icons: ' + todo.length + ' of the mods\' own added to the item texture');
  }
  // the frame of the 'items' texture to draw for an item, right now
  const frameOf = it => (it.custom ? (iconReg.done.has(it.custom) ? 'coopmod/' + it.custom : it.fallback) : it.icon);

  // ---- who has which mod item ----
  // held: Pokémon id -> { 'modId:itemId': { n, s } }; bag (passive items, the whole team's): 'modId:itemId' -> { n, s }
  let held = {}, bag = {}, heldSeed = null;
  const runMark = { wave: 0, time: 0 }; // where the run was when last looked at (to notice it starting over)
  const fromSave = {}; // run seed -> { block, ids } of a save the game has read (block null: that save has none)
  const fieldStates = new WeakMap(); // a Pokémon's summonData (a new object every time it enters the field) -> {}
  const entryOf = (p, key) => (p && held[p.id] && held[p.id][key]) || null;
  const countOf = (p, key) => { const e = entryOf(p, key); return e ? e.n : 0; };
  const holds = (p, key) => countOf(p, key) > 0;
  const bagCount = key => (bag[key] ? bag[key].n : 0);
  const itemOn = key => !!items[key] && isOn(items[key].mod);
  // how many of a held item this Pokémon may hold: the item's max, unless an extension (X.onMax) says otherwise
  // for this Pokémon (异次元树果袋 raises the limit of the items that count as berries). Passive items: it.max.
  const maxFns = [];
  function maxOf(p, key) {
    const it = items[key];
    if (!it) return 0;
    let max = it.max;
    if (it.kind === 'passive' || !p || !maxFns.length || !isOn(it.mod)) return max;
    for (const fn of maxFns) { const r = guard('item max', () => fn(p, key, max)); if (typeof r === 'number' && isFinite(r)) max = Math.max(1, Math.min(Math.floor(r), 999)); }
    return max;
  }
  // what a Pokémon holds that is shown and counted: items of mods that are on
  const shownItems = p => Object.keys((p && held[p.id]) || {}).filter(itemOn).map(k => ({ key: k, def: items[k], state: held[p.id][k].s, count: held[p.id][k].n }));
  const shownBag = () => Object.keys(bag).filter(itemOn).map(k => ({ key: k, def: items[k], state: bag[k].s, count: bag[k].n }));
  // a few words an item says about its own state (def.note(state, count)), for the lists: '' when it has none
  const noteOf = it => { if (!it.def.note) return ''; const t = guard('item note ' + it.key, () => it.def.note(it.state, it.count), ''); return typeof t === 'string' && t ? t.slice(0, 24) : ''; };
  const plain = state => (state && typeof state === 'object' && !Array.isArray(state) ? state : {});
  // one more of an item. Held: for this Pokémon, up to the item's max (false when it has max already).
  // Passive: p is ignored, the item goes into the team bag. from: 'reward' when picked on the reward screen.
  function give(p, key, state, from) {
    const it = items[key];
    if (!it) return false;
    let e;
    if (it.kind === 'passive') {
      e = bag[key];
      if (e && e.n >= it.max) return false;
      if (e) e.n++; else e = bag[key] = { n: 1, s: plain(state) };
      p = null;
    } else {
      if (!p) return false;
      e = entryOf(p, key);
      if (e && it.v1) e.s = plain(state); // 接口版本 1: giving again starts the item over
      else if (e && e.n >= maxOf(p, key)) return false;
      else if (e) e.n++;
      else e = (held[p.id] = held[p.id] || {})[key] = { n: 1, s: plain(state) };
    }
    ov.sig = '';
    log('item ' + key + ' -> ' + (p ? nameOf(p) : 'the team bag') + (e.n > 1 ? ' (×' + e.n + ')' : ''));
    emit('give', { pokemon: p, item: key, count: e.n, from: from || 'mod' });
    return true;
  }
  // n of them away (all of them when n is not given); the last one takes the item and its state with it
  function take(p, key, n) {
    const it = items[key], passive = !!it && it.kind === 'passive';
    const e = passive ? bag[key] : entryOf(p, key);
    if (!e) return false;
    const all = n == null || n === Infinity;
    n = all ? e.n : Math.max(1, Math.floor(Number(n) || 1));
    e.n -= Math.min(n, e.n);
    if (e.n <= 0) {
      if (passive) delete bag[key];
      else { delete held[p.id][key]; if (!Object.keys(held[p.id]).length) delete held[p.id]; }
    }
    ov.sig = '';
    log('item ' + key + (e.n > 0 ? ': ' + e.n + ' left with ' : ' gone from ') + (passive ? 'the team bag' : nameOf(p)));
    emit('remove', { pokemon: passive ? null : p, item: key, left: Math.max(0, e.n) });
    return true;
  }
  const remove = (p, key) => take(p, key, null);
  // is there room for one more of this item? Held: on any Pokémon in the party (who: only that player's own)
  function canTake(key, who) {
    const it = items[key];
    if (!it) return false;
    if (it.kind === 'passive') return bagCount(key) < it.max;
    return partyOf(scene()).some(p => (!who || !window.CoopTeam || CoopTeam.ownerOf(p) === who) && countOf(p, key) < maxOf(p, key));
  }
  const kept = () => { try { return JSON.parse(localStorage.getItem(HELD_KEY) || '{}') || {}; } catch { return {}; } };
  function keep(seed, block, ids) { // this device's copy, for a save rewritten by a build without mods
    const all = kept();
    if (block) all[seed] = { block, ids, t: Date.now() }; else if (all[seed]) delete all[seed]; else return;
    const seeds = Object.keys(all).sort((a, b) => (all[a].t || 0) - (all[b].t || 0));
    seeds.slice(0, Math.max(0, seeds.length - HELD_KEPT)).forEach(id => { delete all[id]; });
    try { localStorage.setItem(HELD_KEY, JSON.stringify(all)); } catch {}
  }
  const isObj = x => !!x && typeof x === 'object' && !Array.isArray(x);
  const validBlock = b => !!(b && (b.v === 1 || b.v === 2) && isObj(b.held) && (b.v === 1 || b.bag == null || isObj(b.bag)));
  // a block of either version -> { held, bag } in today's shape (a copy; anything malformed is left out)
  function readBlock(b) {
    const out = { held: {}, bag: {} };
    const entry = x => (b.v === 1 ? (isObj(x) ? { n: 1, s: x } : null) : isObj(x) && x.n >= 1 ? { n: Math.floor(x.n), s: plain(x.s) } : null);
    for (const id of Object.keys(b.held)) {
      if (!isObj(b.held[id])) continue;
      for (const k of Object.keys(b.held[id])) { const e = entry(b.held[id][k]); if (e) (out.held[id] = out.held[id] || {})[k] = e; }
    }
    if (b.v === 2 && isObj(b.bag)) for (const k of Object.keys(b.bag)) { const e = entry(b.bag[k]); if (e) out.bag[k] = e; }
    return JSON.parse(JSON.stringify(out));
  }
  function loadFor(seed) {
    heldSeed = seed;
    const s = scene(), now = new Set(partyOf(s).map(p => String(p.id)));
    // a block belongs to this run when the party it was saved with shares a Pokémon with today's (a new run on
    // the same seed, a daily run started again, has all new Pokémon: nothing is carried into it)
    const mine = c => !!(c && validBlock(c.block) && (!Array.isArray(c.ids) ? !(c.block.bag && Object.keys(c.block.bag).length) : c.ids.some(id => now.has(String(id)))));
    const sv = fromSave[seed], dev = kept()[seed];
    const c = mine(sv) ? sv : mine(dev) ? dev : null;
    const r = c ? readBlock(c.block) : { held: {}, bag: {} };
    held = r.held; bag = r.bag;
    ov.sig = '';
    const n = Object.keys(held).length, m = Object.keys(bag).length;
    const sig = seed + JSON.stringify([held, bag]);
    if ((n || m) && sig !== loadFor.sig) log('items restored (block v' + c.block.v + ', from ' + (c === sv ? 'the save' : 'this device') + '): held by ' + n + ' Pokémon, ' + m + ' kind(s) in the team bag');
    loadFor.sig = sig;
  }
  function exportBlock(s) {
    const ids = new Set(partyOf(s).map(p => String(p.id))), out = {};
    for (const id of Object.keys(held)) if (ids.has(id) && held[id] && Object.keys(held[id]).length) out[id] = held[id];
    return Object.keys(out).length || Object.keys(bag).length ? { v: 2, held: out, bag } : null;
  }
  function hookSave(s) {
    const gd = s.gameData;
    if (!gd || gd.__coopMods || typeof gd.getSessionSaveData !== 'function') return;
    gd.__coopMods = true;
    const save = gd.getSessionSaveData;
    gd.getSessionSaveData = function () {
      const r = save.apply(this, arguments);
      try {
        if (r && typeof r === 'object' && r.seed) {
          if (r.seed !== heldSeed) loadFor(r.seed);
          const block = exportBlock(s);
          if (block) r[SAVE_KEY] = block; // a key the game's save reader does not know and leaves alone
          keep(r.seed, block, partyOf(s).map(p => p.id));
        }
      } catch (e) { log('save error', String(e)); }
      return r;
    };
    const parse = gd.parseSessionData;
    if (typeof parse === 'function') gd.parseSessionData = function () {
      const r = parse.apply(this, arguments);
      try { if (r && r.seed) fromSave[r.seed] = { block: validBlock(r[SAVE_KEY]) ? r[SAVE_KEY] : null, ids: Array.isArray(r.party) ? r.party.map(p => p && p.id) : null }; } catch {}
      return r;
    };
    const load = gd.loadSession;
    if (typeof load === 'function') gd.loadSession = function () {
      const r = load.apply(this, arguments);
      Promise.resolve(r).then(() => { heldSeed = null; }, () => {}); // this run again from its save
      return r;
    };
    log('save: mod items go into the "' + SAVE_KEY + '" block (v2)');
  }

  // ---- events ----
  const listeners = type => { const out = []; for (const id of order) { const m = mods[id]; if (isOn(id) && m.on[type]) for (const fn of m.on[type]) out.push([m, fn]); } return out; };
  const has = type => active() && order.some(id => isOn(id) && mods[id].on[type] && mods[id].on[type].length);
  function emit(type, ev) {
    let last;
    for (const [m, fn] of listeners(type)) { try { const r = fn(ev); if (r !== undefined) last = r; } catch (e) { problem(m, type, e); } }
    return last;
  }
  const battle = { on: null, wave: -1 }; // on: between the encounter and the end of the battle (null: not seen yet)
  let moveHits = []; // { attacker, target, damage }: move hits since the attacker's move began
  // MovePhase.end queues the MoveEndPhase with the user's battler index. When the user has fainted meanwhile (its
  // own recoil) and the game has moved its teammate into that field slot, the index names the teammate. So the
  // user is remembered when its MovePhase ends: { mon, bi }.
  let movers = [];
  let healCtx = null; // the tag of the B.heal that is being carried out right now
  const phaseNow = () => { try { return scene().phaseManager.getCurrentPhase().phaseName; } catch { return null; } };
  function phaseEvent(when, ph) {
    const name = ph && ph.phaseName;
    if (!name) return;
    for (const id of order) {
      const m = mods[id];
      if (!isOn(id)) continue;
      for (const h of m.phase) if (h.name === name && h.when === when) { try { h.fn(ph); } catch (e) { problem(m, name + ' ' + when, e); } }
    }
    if (when !== 'start') {
      if (name === 'MovePhase' && ph.pokemon) { let bi = -1; try { bi = ph.pokemon.getBattlerIndex(); } catch {} if (movers.length > 12) movers = []; movers.push({ mon: ph.pokemon, bi, moveId: ph.move && ph.move.moveId != null ? ph.move.moveId : null }); }
      return;
    }
    if (name === 'TurnInitPhase') {
      movers = [];
      const b = scene().currentBattle, w = b ? b.waveIndex : -1;
      if (w !== battle.wave) { battle.wave = w; moveHits = []; emit('battleStart', { wave: w, turn: b ? b.turn : 0 }); }
    } else if (name === 'TurnStartPhase') { moveHits = []; markTurn(); emit('turnStart', {}); }
    else if (name === 'TurnEndPhase') emit('turnEnd', {});
    else if (name === 'BattleEndPhase') emit('battleEnd', { wave: B.wave(), victory: ph.isVictory !== false });
    else if (name === 'FaintPhase') { let p = null; try { p = ph.getPokemon(); } catch {} if (p && p.hp <= 0) emit('faint', { pokemon: p }); }
    else if (name === 'MoveEndPhase') {
      let p = null; try { p = ph.getPokemon(); } catch {}
      let used = null; // the move the MovePhase was for (a Pokémon that has left the field has no move history any more)
      for (let i = movers.length - 1; i >= 0; i--) if (movers[i].bi === ph.battlerIndex) { p = movers[i].mon; used = movers[i].moveId; movers.splice(i, 1); break; }
      if (!p) return;
      const hits = moveHits.filter(h => h.attacker === p);
      moveHits = moveHits.filter(h => h.attacker !== p);
      if (!has('moveUsed')) return;
      let last = null; try { last = p.getLastXMoves(1)[0] || null; } catch {}
      emit('moveUsed', { pokemon: p, moveId: last ? last.move : used, targets: last && last.targets ? last.targets.slice() : hits.map(h => { try { return h.target.getBattlerIndex(); } catch { return null; } }).filter(x => x != null),
        ok: last ? last.result === 1 : hits.length > 0, // (no history: the user has left the field; a move that hit somebody counts as done)
        damage: hits.reduce((a, h) => a + h.damage, 0), hits: hits.map(h => ({ target: h.target, damage: h.damage })), followUp: !!ph.wasFollowUp });
    }
  }
  function trackBattle(name) {
    if (name === 'EncounterPhase' || name === 'NextEncounterPhase' || name === 'NewBiomeEncounterPhase') battle.on = true;
    else if (name === 'BattleEndPhase' || name === 'SelectModifierPhase' || name === 'TitlePhase' || name === 'GameOverPhase') battle.on = false;
    if (name === 'TitlePhase' || name === 'GameOverPhase') battle.wave = -1; // back at the title: the next wave entered is a new battle, also when its number is the same
  }

  // ---- hooks into the game (installed the first time a mod is on in a co-op room) ----
  const hooked = {}; // which hooks are in: phases, pokemon, statChange, rewards, heal
  const WRAPS = '__coopModsWraps', ORIGS = '__coopModsOrigs';
  // remember obj[method] as it is now, unless it was remembered before: what X.gameMethod answers later
  function noteOrig(obj, method) {
    if (!obj || typeof obj[method] !== 'function') return;
    if (!Object.prototype.hasOwnProperty.call(obj, ORIGS)) Object.defineProperty(obj, ORIGS, { value: {}, enumerable: false });
    if (!obj[ORIGS][method]) obj[ORIGS][method] = obj[method];
  }
  // obj[method] as it was before the core or any extension wrapped it (on that same object); obj[method] itself when nobody has
  const gameMethod = (obj, method) => (obj && Object.prototype.hasOwnProperty.call(obj, ORIGS) && obj[ORIGS][method]) || (obj ? obj[method] : undefined);
  // Replace obj[method] by make(original), once per (obj, method, tag): a second call with the same tag does
  // nothing. obj is a prototype (or one object, like a UI handler). While no mod is on, or outside a co-op
  // room, the original is called directly.
  function wrapOnce(obj, method, tag, make, kind) {
    if (!obj || typeof obj[method] !== 'function') { log('hooks: no ' + method + ' to wrap (' + tag + ')'); return false; }
    if (!Object.prototype.hasOwnProperty.call(obj, WRAPS)) Object.defineProperty(obj, WRAPS, { value: {}, enumerable: false });
    const marks = obj[WRAPS], k = tag + ':' + method + ':' + (kind || 'wrap');
    if (marks[k]) return true;
    const orig = obj[method];
    noteOrig(obj, method);
    let repl = null;
    try { repl = make(orig); } catch (e) { log('hooks: wrapping ' + method + ' (' + tag + ') failed: ' + String(e)); }
    if (typeof repl !== 'function') return false;
    marks[k] = true;
    obj[method] = function () { return active() && anyOn() ? repl.apply(this, arguments) : orig.apply(this, arguments); };
    return true;
  }
  const guards = {};
  function guard(what, fn, fallback) { // run fn; an error is logged (20 times at most per name) and does not travel on
    try { return fn(); } catch (e) {
      const n = guards[what] = (guards[what] || 0) + 1;
      if (n <= 20) log('error in ' + what + ': ' + String((e && e.stack) || e).slice(0, 300));
      return fallback;
    }
  }
  // fn(self, args) runs before the original: return { args: [...] } to change the arguments, { skip: true, value }
  // to not call the original at all; anything else (or an error) lets it run as it was called.
  const before = (obj, method, tag, fn) => wrapOnce(obj, method, tag, orig => function (...args) {
    const r = guard(tag + ' before ' + method, () => fn(this, args));
    if (r && r.skip) return r.value;
    return orig.apply(this, r && Array.isArray(r.args) ? r.args : args);
  }, 'before');
  // fn(self, args, result) runs after the original: return { value } to change what the caller gets.
  const after = (obj, method, tag, fn) => wrapOnce(obj, method, tag, orig => function (...args) {
    const res = orig.apply(this, args);
    const r = guard(tag + ' after ' + method, () => fn(this, args, res));
    return r && typeof r === 'object' && 'value' in r ? r.value : res;
  }, 'after');
  const protoWith = (obj, method) => { // the prototype in obj's chain that defines method itself
    for (let p = obj && Object.getPrototypeOf(obj); p && p !== Object.prototype; p = Object.getPrototypeOf(p)) if (Object.prototype.hasOwnProperty.call(p, method)) return p;
    return null;
  };
  const phaseProtos = {}, phaseClassFns = {}; // phase name -> its prototype (once seen) / what extensions want to do with it
  let pokemonProto = null; const pokemonClassFns = [];
  const tickFns = [], rewardFns = [];
  let optionProto = null; // ModifierTypeOption.prototype, taken from the first option the game makes

  function hookPhases(s) {
    const pm = s.phaseManager;
    if (pm.__coopMods) return;
    pm.__coopMods = true; hooked.phases = true;
    // every phase starts through startCurrentPhase and ends through shiftPhase (Phase.end)
    const start = pm.startCurrentPhase;
    pm.startCurrentPhase = function () {
      try { const ph = this.currentPhase; if (ph) { patchPhase(ph); trackBattle(ph.phaseName); if (active() && anyOn()) phaseEvent('start', ph); } } catch (e) { log('phase start hook error', String(e)); }
      return start.apply(this, arguments);
    };
    const shift = pm.shiftPhase;
    pm.shiftPhase = function () {
      try { const ph = this.currentPhase; if (ph && active() && anyOn()) phaseEvent('end', ph); } catch (e) { log('phase end hook error', String(e)); }
      return shift.apply(this, arguments);
    };
    log('hooks: phases');
    // The phase that is running right now started before these hooks existed (a mod switched on for the first
    // time in this session, in the middle of a reward screen or a turn): its class is patched now, so that what
    // the extensions wrap on it (reroll price, option count ...) already answers for the rest of this phase.
    try { if (pm.currentPhase) patchPhase(pm.currentPhase); } catch (e) { log('phase hook error (current phase)', String(e)); }
  }
  function patchPhase(ph) {
    const proto = Object.getPrototypeOf(ph), name = ph.phaseName;
    if (!proto || !name || phaseProtos[name] === proto) return;
    phaseProtos[name] = proto;
    for (const fn of phaseClassFns[name] || []) guard('phase class ' + name, () => fn(proto, ph));
    if (Object.prototype.hasOwnProperty.call(proto, '__coopMods')) return;
    if (name === 'StatStageChangePhase' && typeof proto.applyStatChangesAndEnd === 'function') {
      proto.__coopMods = true; hooked.statChange = true;
      noteOrig(proto, 'applyStatChangesAndEnd');
      const apply = proto.applyStatChangesAndEnd;
      // (pokemon, changes): changes are what really applies, [{stat, stages}], already clamped to -6..+6
      proto.applyStatChangesAndEnd = function (pokemon, changes) {
        const r = apply.apply(this, arguments);
        try {
          if (has('statChange')) {
            const real = (changes || []).filter(c => c && c.stages).map(c => ({ stat: c.stat, stages: c.stages, name: STAT_NAMES[c.stat] || null }));
            if (real.length) emit('statChange', { pokemon, changes: real, copied: !!(this.options && this.options.coopModCopy) });
          }
        } catch (e) { log('stat change hook error', String(e)); }
        return r;
      };
    } else if (name === 'SelectModifierPhase' && typeof proto.getModifierTypeOptions === 'function' && typeof proto.applyChosenModifier === 'function') {
      proto.__coopMods = true; hooked.rewards = true;
      noteOrig(proto, 'getModifierTypeOptions'); noteOrig(proto, 'applyChosenModifier');
      const options = proto.getModifierTypeOptions;
      proto.getModifierTypeOptions = function () {
        let opts = options.apply(this, arguments);
        try {
          if (Array.isArray(opts)) {
            if (opts[0] && !optionProto) optionProto = Object.getPrototypeOf(opts[0]);
            offer(this, opts);
            if (active() && anyOn()) for (const fn of rewardFns) { const r = guard('reward options', () => fn(this, opts)); if (Array.isArray(r)) opts = r; }
          }
        } catch (e) { log('reward offer error', String(e)); }
        return opts;
      };
      const chosen = proto.applyChosenModifier;
      proto.applyChosenModifier = function (type, cost, cb) {
        if (!type || !type.__coopMod) return chosen.apply(this, arguments);
        try { return pickItem(this, type, cost, cb); } catch (e) { log('reward pick error', String(e)); return false; }
      };
    } else if (name === 'PokemonHealPhase' && typeof proto.doHealPokemon === 'function') {
      proto.__coopMods = true; hooked.heal = true;
      noteOrig(proto, 'doHealPokemon');
      const doHeal = proto.doHealPokemon; // where the phase really restores the HP
      proto.doHealPokemon = function () {
        healCtx = this.__coopModHeal || null;
        try { return doHeal.apply(this, arguments); } finally { healCtx = null; }
      };
    }
  }
  function hookPokemon(s) {
    if (hooked.pokemon) return;
    const any = partyOf(s)[0] || (s.currentBattle && s.currentBattle.enemyParty && s.currentBattle.enemyParty[0]);
    if (!any) return;
    let proto = Object.getPrototypeOf(any); // PlayerPokemon / EnemyPokemon -> Pokemon
    while (proto && !Object.prototype.hasOwnProperty.call(proto, 'damageAndUpdate')) proto = Object.getPrototypeOf(proto);
    if (!proto || proto.__coopMods) { hooked.pokemon = !!proto; if (!proto) log('hooks: Pokemon class not found in this build'); else pokemonReady(proto); return; }
    proto.__coopMods = true; hooked.pokemon = true;
    const wrap = (name, make) => { if (typeof proto[name] === 'function') { noteOrig(proto, name); proto[name] = make(proto[name]); } else log('hooks: no Pokemon.' + name + ' in this build'); };
    // damage a move would do. Returns {cancelled, result, damage}; the game calls it for real hits and, with
    // simulated (the default), for the enemy AI's estimates.
    wrap('getAttackDamage', orig => function (o) {
      const r = orig.apply(this, arguments);
      try {
        if (r && r.damage > 0 && !r.cancelled && o && o.source && has('damageCalc')) {
          const ev = { attacker: o.source, target: this, move: o.move, simulated: o.simulated !== false, critical: !!o.isCritical, damage: r.damage };
          for (const [m, fn] of listeners('damageCalc')) { try { const d = fn(ev); if (typeof d === 'number' && isFinite(d)) ev.damage = d; } catch (e) { problem(m, 'damageCalc', e); } }
          let d = Math.max(1, Math.floor(ev.damage));
          // a limit the game itself put on this hit stays: False Swipe, Sturdy at full HP (both leave 1 HP)
          if (d > r.damage && r.damage === this.hp - 1) {
            let limited = false;
            try { limited = !!(o.move && o.move.hasAttr && o.move.hasAttr('ModifiedDamageAttr')) || (!o.ignoreAbility && this.isFullHp() && this.hasAbilityWithAttr('PreDefendFullHpEndureAbAttr')); } catch {}
            if (limited) d = r.damage;
          }
          r.damage = d;
        }
      } catch (e) { log('damage calc hook error', String(e)); }
      return r;
    });
    // every loss of HP with an animation (move hits pass opts.source, the attacker)
    wrap('damageAndUpdate', orig => function (dmg, opts) {
      let after = null;
      try {
        if (dmg > 0 && !this.isFainted() && has('beforeDamage')) {
          const o = opts || {};
          const ev = { target: this, damage: dmg, source: o.source || null, byMove: !!o.source, lethal: dmg >= this.hp, fullHp: this.hp === this.getMaxHp(), then: fn => { (after = after || []).push(fn); } };
          for (const [m, fn] of listeners('beforeDamage')) { try { const d = fn(ev); if (typeof d === 'number' && isFinite(d)) { ev.damage = Math.max(0, Math.floor(d)); ev.lethal = ev.damage >= this.hp; } } catch (e) { problem(m, 'beforeDamage', e); } }
          dmg = ev.damage;
        }
      } catch (e) { log('damage hook error', String(e)); }
      const r = orig.call(this, dmg, opts);
      try { if (r > 0 && opts && opts.source && active() && anyOn()) { if (moveHits.length > 200) moveHits = []; moveHits.push({ attacker: opts.source, target: this, damage: r }); } } catch {}
      if (after) for (const fn of after) { try { fn(r); } catch (e) { log('after damage error', String(e)); } }
      return r;
    });
    // may this Pokémon choose this move? Returns [ok, text shown when not]
    wrap('isMoveSelectable', orig => function (moveId) {
      try {
        if (has('moveSelect')) for (const [m, fn] of listeners('moveSelect')) {
          let no; try { no = fn({ pokemon: this, moveId }); } catch (e) { problem(m, 'moveSelect', e); }
          if (typeof no === 'string' && no) return [false, no];
        }
      } catch (e) { log('move select hook error', String(e)); }
      return orig.apply(this, arguments);
    });
    wrap('doSetStatus', orig => function (effect) {
      const r = orig.apply(this, arguments);
      try { if (STATUS[effect] && has('status')) emit('status', { pokemon: this, status: STATUS[effect] }); } catch (e) { log('status hook error', String(e)); }
      return r;
    });
    // every gain of HP (heal phases, abilities, medicine used from the reward screen...). Returns what was really restored.
    wrap('heal', orig => function () {
      const r = orig.apply(this, arguments);
      try { if (r > 0 && has('heal')) emit('heal', { pokemon: this, amount: r, tag: healCtx ? healCtx.tag : null, inBattle: B.inBattle(), phase: phaseNow() }); } catch (e) { log('heal hook error', String(e)); }
      return r;
    });
    log('hooks: Pokemon damage, move choice, status, heal');
    pokemonReady(proto);
  }
  function pokemonReady(proto) {
    if (pokemonProto) return;
    pokemonProto = proto;
    for (const fn of pokemonClassFns) guard('pokemon class', () => fn(proto));
  }

  // ---- rewards ----
  const cfg = { normalOffer: true, screenChance: 0.1 }; // extensions may change these (X.cfg)
  const SCREEN_WEIGHT = [8, 6, 5, 3, 2]; // by rarity: COMMON, GREAT, ULTRA, ROGUE, MASTER
  const debug = { force: [] }; // test only: item keys the next reward screen must offer
  function rng(str) { // small seeded generator: the same string always gives the same numbers
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return () => { h = (h + 0x6D2B79F5) | 0; let t = h; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }
  // a reward option for a mod item. like: any option the game made (for its class); may be left out once the
  // game has shown a reward screen in this session.
  function makeOption(like, key, upgradeCount) {
    const it = items[key];
    if (!it) return null;
    const type = { // what the reward screen reads of an item type: name, iconImage, tier, getDescription()
      id: 'COOPMOD_' + key.toUpperCase().replace(/[^A-Z0-9]+/g, '_'), localeKey: '', name: it.name, group: 'coopmod:' + key, soundName: 'se/restore',
      get iconImage() { return frameOf(it); }, tier: TIER[it.tier], __coopMod: key,
      getDescription: () => it.description,
      setTier(t) { this.tier = t; }, getOrInferTier() { return this.tier; }, withIdFromFunc() { return this; }, withTierFromPool() { return this; },
      newModifier() { return { type: this }; }, // not a game modifier: scene.addModifier does nothing with it
    };
    const opt = Object.create((like && Object.getPrototypeOf(like)) || optionProto || Object.prototype); // a ModifierTypeOption
    opt.type = type; opt.upgradeCount = upgradeCount || 0; opt.cost = 0;
    return opt;
  }
  // the normal reward after a battle, first round (host-team.js tags it; the second round is what is left of it)
  function offer(ph, opts) {
    const c = ph.__coop;
    const forced = debug.force.splice(0).filter(k => items[k]);
    if (!active() || !c || c.round !== 1 || c.single || ph.customModifierSettings || ph.isCopy) return;
    if (!forced.length && (!anyOn() || !cfg.normalOffer)) return;
    const s = scene(), b = s.currentBattle;
    const roll = rng([s.seed, b ? b.waveIndex : 0, ph.rerollCount || 0, 'coop-mods'].join(':'));
    const taken = new Set(), put = [];
    const open = k => isOn(items[k].mod) && !taken.has(k) && canTake(k, c.picker); // nobody has room for it: not offered
    opts.forEach((opt, i) => {
      const r = roll();
      if (!opt || !opt.type) return;
      let key = null;
      if (forced.length) key = forced.shift();
      else if (!anyOn() || !cfg.normalOffer) return; // (a forced list shorter than the screen: the other slots stay the game's)
      else {
        const tier = opt.type.tier, pool = POOL[tier];
        const cands = Object.keys(items).filter(k => TIER[items[k].tier] === tier && open(k));
        if (!pool || !cands.length) return;
        const w = k => Math.max(0, Math.min(Number(items[k].weight) || 0, pool.cap));
        const total = pool.total + cands.reduce((a, k) => a + w(k), 0);
        let acc = 0;
        for (const k of cands) { acc += w(k) / total; if (r < acc) { key = k; break; } }
      }
      if (!key || taken.has(key)) return;
      taken.add(key);
      opts[i] = makeOption(opt, key, opt.upgradeCount);
      put.push(key);
    });
    // On top of the rarity pools (where a ROGUE or MASTER item would turn up once in hundreds of screens): with
    // mods on, about one reward screen in ten swaps one of its options for a mod item, picked by rarity weight.
    if (!put.length && anyOn() && cfg.normalOffer && roll() < cfg.screenChance) {
      const cands = Object.keys(items).filter(k => SCREEN_WEIGHT[TIER[items[k].tier]] && open(k));
      const slots = opts.map((o, i) => (o && o.type ? i : -1)).filter(i => i >= 0);
      if (cands.length && slots.length) {
        const w = k => SCREEN_WEIGHT[TIER[items[k].tier]], total = cands.reduce((x, k) => x + w(k), 0);
        let r = roll() * total, key = cands[cands.length - 1];
        for (const k of cands) { r -= w(k); if (r < 0) { key = k; break; } }
        const i = slots[Math.floor(roll() * slots.length)];
        opts[i] = makeOption(opts[i], key, 0);
        put.push(key);
      }
    }
    if (put.length) log('rewards: offered ' + put.join(', '));
  }
  const handlerIndex = (s, name, fallback) => { const i = (s.ui.handlers || []).findIndex(h => h && h.constructor && h.constructor.name === name); return i >= 0 ? i : fallback; };
  const fullText = (p, it) => (p ? nameOf(p) + '的' : '队伍的') + it.name + '已经带满了（最多' + (p ? maxOf(p, it.key) : it.max) + '个）';
  // a mod item was picked on the reward screen. A passive item goes into the team bag. A held item asks which
  // Pokémon holds it, the way the game does for its own held items (party menu in MODIFIER mode; host-team.js
  // limits it to the picker's own Pokémon); one that already has the item's max is refused.
  function pickItem(ph, type, cost, cb) {
    const s = scene(), key = type.__coopMod, it = items[key];
    if (!it) { s.ui.playError(); return false; }
    if (it.kind === 'passive') {
      if (!give(null, key, {}, 'reward')) { // the bag has its max: the screen stays as it is
        log('rewards: ' + key + ' refused, the team bag has ' + it.max);
        try { s.ui.playError(); } catch {}
        return false;
      }
      try { s.ui.playSelect(); } catch {}
      ph.applyModifier({ type }, cost, true); // ends the reward round like any other pick
      return cost === -1;
    }
    const party = s.getPlayerParty(), partyMode = handlerIndex(s, 'PartyUiHandler', 8);
    const rewardMode = typeof s.ui.mode === 'number' ? s.ui.mode : handlerIndex(s, 'ModifierSelectUiHandler', 6); // the screen we are on
    s.ui.setModeWithoutClear(partyMode, 4 /* PartyUiMode.MODIFIER */, -1, slot => {
      if (slot < 6 && party[slot] && countOf(party[slot], key) < maxOf(party[slot], key)) {
        s.ui.setMode(rewardMode, ph.isPlayer()).then(() => {
          give(party[slot], key, {}, 'reward');
          try { s.ui.playSelect(); } catch {}
          ph.applyModifier({ type }, cost, true); // ends the reward round like any other pick
        });
      } else ph.resetModifierSelect(cb);
    }, p => (countOf(p, key) >= maxOf(p, key) ? fullText(p, it) : null));
    return cost === -1;
  }

  // ---- what a mod may ask of the battle (the stable part: mods use these, not the game's objects) ----
  const nameOf = p => (p ? (p.getNameToRender ? p.getNameToRender() : p.name) : '');
  const whoAt = (s, slot) => (window.CoopTeam && CoopTeam.ownerOf(s.getPlayerField()[slot])) || (slot === 1 ? 'p2' : 'p1');
  const targetsOf = c => (c.targets && c.targets.length ? c.targets : (c.move && c.move.targets) || []);
  // 集火 this turn. host-game.js decides it (and counts the streak shown on its banner) a moment after the turn
  // starts; its verdict is `combo`. Until it arrives the same rule is read from the game when the turn starts
  // (`mark`), counting on from host-game.js's streak of the turn before. A verdict only counts when it came
  // after the turn really started (host-game.js can speak early when something runs between the two players'
  // command menus).
  let combo = null, seq = 0; // {key: 'wave:turn', target, streak, seq}
  let mark = { key: '', target: null, streak: 0, seq: 0 };
  function watchCombo() {
    if (combo || !window.CoopGame) return;
    combo = { key: '', target: null, streak: 0, seq: 0 };
    CoopGame.on((type, d) => {
      if (type !== 'turnstart') return;
      combo = { key: turnKey(), target: d && d.combo ? d.target : null, streak: d && d.combo ? Number(d.streak) || 1 : 0, seq: ++seq };
    });
  }
  const turnKey = () => { const b = scene() && scene().currentBattle; return b ? b.waveIndex + ':' + b.turn : ''; };
  // the rule itself (the same as host-game.js): both players' Pokémon aim one single-target move at the same enemy
  function aimedAt() {
    const s = scene(), b = s && s.currentBattle;
    if (!b || !b.double || !b.turnCommands) return null;
    const aim = c => (c && c.command === 0 && targetsOf(c).length === 1 ? targetsOf(c)[0] : null);
    const t0 = aim(b.turnCommands[0]), t1 = aim(b.turnCommands[1]);
    return whoAt(s, 0) !== whoAt(s, 1) && t0 != null && t0 >= 2 && t0 === t1 ? t0 : null;
  }
  const hostStreak = () => { try { return Number(CoopGame.state().streak) || 0; } catch { return 0; } };
  function markTurn() { // the turn starts now: every command is in
    const target = aimedAt();
    mark = { key: turnKey(), target, streak: target != null ? hostStreak() + 1 : 0, seq: ++seq };
  }
  const verdict = () => { const key = turnKey(); return !key ? null : combo && combo.key === key && combo.seq > mark.seq ? combo : mark.key === key ? mark : null; };
  const B = {
    name: nameOf,
    isPlayer: p => !!(p && p.isPlayer && p.isPlayer()),
    index: p => p.getBattlerIndex(),                    // 0, 1: the players' side; 2, 3: the enemies
    owner: p => (window.CoopTeam ? CoopTeam.ownerOf(p) : null), // 'p1' | 'p2'
    hp: p => p.hp, maxHp: p => p.getMaxHp(),
    onField: p => !!(p && p.isActive && p.isActive(true) && !p.isFainted()),
    fainted: p => !!(p && p.isFainted && p.isFainted()),
    playerField: () => scene().getPlayerField().filter(p => B.onField(p)),
    enemyField: () => scene().getEnemyField().filter(p => B.onField(p)),
    // every Pokémon of the two players, in the party's order / those not on the field (fainted ones included)
    party: () => partyOf(scene()).slice(),
    bench: () => partyOf(scene()).filter(p => !(p.isOnField && p.isOnField())),
    // the other Pokémon on the same side, if it is on the field and standing
    ally: p => { let a = null; try { a = p.getAlly(); } catch {} return B.onField(a) ? a : null; },
    // two different Pokémon on the same side (whoever owns them)
    isAlly: (a, b) => !!(a && b && a !== b && B.isPlayer(a) === B.isPlayer(b)),
    status: p => STATUS[(p && p.status && p.status.effect) || 0] || null, // 'poison' | 'toxic' | 'paralysis' | 'sleep' | 'freeze' | 'burn' | null
    statusName: st => STATUS_ZH[st] || '',
    wave: () => (scene().currentBattle || {}).waveIndex || 0,
    turn: () => (scene().currentBattle || {}).turn || 0,
    // between the start of an encounter and the end of its battle (not on the reward screen, not in a shop)
    inBattle() {
      if (battle.on != null) return battle.on && !!scene().currentBattle;
      const n = phaseNow();
      return !!scene().currentBattle && n !== 'SelectModifierPhase' && n !== 'BattleEndPhase' && n !== 'TitlePhase';
    },
    message: text => scene().phaseManager.queueMessage(String(text)),
    // lose HP now, with the game's hit animation; not a move hit (no attacker). opts.indirect: like poison or
    // 生命宝珠's recoil (no hit sound of a move; 气势头带 and the like do not answer it)
    damage: (p, amount, opts) => p.damageAndUpdate(Math.max(1, Math.floor(amount)), opts && opts.indirect ? { result: 12 /* HitResult.INDIRECT */ } : {}),
    // Restore HP in battle the game's own way: its heal animation, the number over the Pokémon, 回复护符 counts.
    // Queued like a message: it happens when the queue gets there. opts: message (shown after), tag (the 'heal'
    // event this causes carries it, so a handler can tell its own heals apart), quiet (no animation).
    // false: not on the field, already at full HP, or nothing to restore.
    heal(p, amount, opts) {
      const o = opts || {};
      amount = Math.floor(Number(amount) || 0);
      if (!(amount > 0) || !B.onField(p) || p.isFullHp()) return false;
      const pm = scene().phaseManager;
      const ph = pm.create('PokemonHealPhase', p.getBattlerIndex(), amount, { message: o.message ? String(o.message) : undefined, showFullHpMessage: false, skipAnim: !!o.quiet });
      ph.__coopModHeal = { tag: o.tag == null ? null : String(o.tag) };
      pm.unshiftPhase(ph);
      return true;
    },
    // cured when the queued messages get there; false when there is nothing to cure
    cureStatus(p, text) {
      const st = B.status(p);
      if (!st) return false;
      scene().phaseManager.queueMessage(text || nameOf(p) + '的' + STATUS_ZH[st] + '治好了！');
      p.resetStatus(false, false, false, true);
      return true;
    },
    // stat stages now: { atk, def, spatk, spdef, spd, acc, eva }, each -6..+6
    statStages(p) { const out = {}; STAT_NAMES.forEach((n, i) => { if (n) out[n] = (p.getStatStage && p.getStatStage(i)) || 0; }); return out; },
    // the Pokémon's own number for a stat ('atk' ... 'spd'; stages, items and abilities not counted)
    stat: (p, stat) => { const n = statNum(stat); return n >= 1 && n <= 5 ? p.getStat(n, false) : 0; },
    // the highest of 攻击 防御 特攻 特防 速度 (HP is not looked at); the first in that order when two are equal
    highestStat(p) { let best = 'atk', top = -1; for (const n of statApi.battle) { const v = B.stat(p, n); if (v > top) { top = v; best = n; } } return best; },
    // raise (n > 0) or lower (n < 0) the Pokémon's own stat stages, as if it had done it itself (the game's
    // animation and message; 唱反调 and 单纯 apply; a statChange event follows, not marked copied).
    // stat: a name ('atk'), a list of names, or 'all' (the five battle stats).
    raise(p, stat, n) {
      n = Math.trunc(n == null ? 1 : Number(n) || 0);
      const list = (stat === 'all' ? statApi.battle : [].concat(stat)).map(statNum).filter(Boolean);
      if (!n || !list.length || !B.onField(p)) return false;
      scene().phaseManager.unshiftNew('StatStageChangePhase', { battlerIndex: p.getBattlerIndex(), sourcePokemon: p, changes: list.map(st => ({ stat: st, stages: n })) });
      return true;
    },
    // the same stat stages for another Pokémon; marked so that no mod reacts to it again (event.copied)
    changeStats(p, changes) {
      const list = (changes || []).filter(c => c && c.stages && statNum(c.stat)).map(c => ({ stat: statNum(c.stat), stages: c.stages }));
      if (!list.length || !B.onField(p)) return false;
      scene().phaseManager.unshiftNew('StatStageChangePhase', { battlerIndex: p.getBattlerIndex(), sourcePokemon: p, changes: list, ignoreAbilities: true, coopModCopy: true });
      return true;
    },
    moveName(p, moveId) { const m = p.getMoveset().find(x => x && x.moveId === moveId); return m ? m.getName() : '那个招式'; },
    // moves used since entering the field, and the first one chosen by the player from position n on
    moveCount: p => p.getMoveHistory().length,
    firstMoveSince(p, n) {
      const h = p.getMoveHistory();
      for (let i = Math.max(0, n || 0); i < h.length; i++) { const m = h[i]; if (m && m.move && m.move !== 165 /* 挣扎 */ && !(m.useMode > 2)) return m.move; }
      return null;
    },
    // 集火: the enemy both players' Pokémon aim one single-target move at this turn (battler index), or null.
    // The same verdict as host-game.js's 集火 banner (before the turn starts: what the commands so far say).
    focusTarget() { const v = verdict(); return v ? v.target : aimedAt(); },
    // 集火层数: how many turns in a row, this one included, the two players have focused (host-game.js counts
    // it and shows it on the 集火 banner). 0 when this turn is not a 集火.
    focusStreak() { const v = verdict(); return v ? v.streak : aimedAt() == null ? 0 : hostStreak() + 1; },
    // a number in [0, 1) that is the same for the same run, wave, turn and tag (so a reload replays it)
    random: tag => rng([scene().seed, B.wave(), B.turn(), String(tag == null ? '' : tag)].join(':'))(),
  };
  const apiExt = []; // extensions: mod => ({ ... }) merged into each mod's api object
  const isMon = x => !!x && typeof x === 'object' && typeof x.getBattlerIndex === 'function';
  function makeApi(mod) {
    const api = {
      version: API_VERSION,
      manifest: mod.manifest,
      battle: B,
      STAT: statApi,
      log: (...a) => log('[' + mod.id + ']', ...a),
      // a new item: { id, name, description, tier: 'ULTRA' | 'ROGUE' | 'MASTER' (also 'COMMON', 'GREAT'), weight,
      //   kind: 'held' (default) | 'passive', max (default 1), icon (a packed file's name or a frame of the game's item atlas) }
      item(def) {
        if (!def || !/^[a-z0-9][a-z0-9-]{1,39}$/.test(def.id || '')) throw new Error('item id must be lowercase letters, digits and -');
        if (!(def.tier in TIER)) throw new Error('item ' + def.id + ': tier must be one of ' + Object.keys(TIER).join(', '));
        if (!def.name || !def.description) throw new Error('item ' + def.id + ': name and description are required');
        const kind = def.kind == null ? 'held' : def.kind;
        if (kind !== 'held' && kind !== 'passive') throw new Error('item ' + def.id + ": kind must be 'held' or 'passive'");
        const max = def.max == null ? 1 : Math.floor(Number(def.max));
        if (!(max >= 1 && max <= 999)) throw new Error('item ' + def.id + ': max must be a whole number from 1 to 999');
        const key = mod.id + ':' + def.id;
        if (items[key]) throw new Error('item ' + key + ' defined twice');
        // icon: no name -> the packed picture called like the item, if the mod brought one
        const want = def.icon == null ? def.id : String(def.icon).replace(/\.png$/, '');
        const custom = iconData[mod.id + '/' + want] ? mod.id + '/' + want : null;
        const it = items[key] = { key, mod: mod.id, id: def.id, name: String(def.name), description: String(def.description), tier: def.tier, weight: Number(def.weight) || 0,
          kind, max, v1: mod.v1, icon: custom ? want : String(def.icon || 'unknown'), custom, fallback: String(def.iconFallback || 'unknown'),
          note: typeof def.note === 'function' ? def.note : null };
        mod.items.push(key);
        const on = () => isOn(mod.id), passive = kind === 'passive';
        return {
          key, id: def.id, name: it.name, kind, max,
          // held: does this Pokémon have it; passive: is there one in the team bag. Always false while the mod is off.
          heldBy: p => on() && (passive ? bagCount(key) > 0 : holds(p, key)),
          count: p => (!on() ? 0 : passive ? bagCount(key) : countOf(p, key)),
          // a plain object kept in the save, one per holder (per team for a passive item): put only JSON values in it
          state: p => { const e = passive ? bag[key] : entryOf(p, key); return e ? e.s : null; },
          give: (a, b) => (passive ? give(null, key, isMon(a) || a == null ? b : a) : give(a, key, b)),
          take: (a, b) => (passive ? take(null, key, typeof a === 'number' ? a : typeof b === 'number' ? b : 1) : take(a, key, b == null ? 1 : b)),
          remove: p => remove(passive ? null : p, key),
          // the Pokémon in the party that have it (held items; in the party's order)
          holders: () => (on() && !passive ? partyOf(scene()).filter(p => holds(p, key)) : []),
          canTake: who => canTake(key, who),
        };
      },
      on(type, fn) {
        if (!EVENTS.includes(type)) throw new Error('unknown event ' + type + ' (known: ' + EVENTS.join(', ') + ')');
        if (typeof fn !== 'function') throw new Error('api.on(' + type + '): a function is needed');
        (mod.on[type] = mod.on[type] || []).push(fn);
      },
      // a game phase by its class name ('TurnInitPhase', 'ObtainStatusEffectPhase' ...), before it starts or as it ends
      onPhase(name, fn, when) { mod.phase.push({ name: String(name), when: when === 'end' ? 'end' : 'start', fn }); },
      // memory that lasts while the Pokémon stays on the field (gone when it is switched out); never saved
      fieldState(p, tag) {
        const sd = p && p.summonData;
        if (!sd || typeof sd !== 'object') return {};
        let m = fieldStates.get(sd);
        if (!m) fieldStates.set(sd, m = {});
        const k = mod.id + ':' + (tag || '');
        return m[k] = m[k] || {};
      },
      // true the first time it is asked with this tag in a turn (wave:turn), false after that
      oncePerTurn(tag) {
        const k = String(tag == null ? '' : tag), now = (scene().seed || '') + ':' + turnKey();
        if (mod.once[k] === now) return false;
        mod.once[k] = now;
        return true;
      },
    };
    for (const f of apiExt) { const more = guard('api extension for ' + mod.id, () => f(mod, api)); if (more && typeof more === 'object') for (const k of Object.keys(more)) { if (k in api) log('api extension: ' + k + ' is taken, left out'); else api[k] = more[k]; } }
    return api;
  }

  // ---- drawn into the game (host window and the guest's video): who holds what ----
  const ov = { scene: null, layer: null, sig: '' };
  const BATTLE_MODES = ['COMMAND', 'FIGHT', 'TARGET_SELECT', 'BALL', 'MESSAGE'];
  const ownerCss = p => { const w = B.owner(p); return w === 'p1' ? '#4aa3ff' : w === 'p2' ? '#f5c84c' : '#f8f8f8'; };
  function text(s, str, color, size) {
    return new Phaser.GameObjects.Text(s, 0, 0, str, { fontFamily: 'emerald', fontSize: size, color, padding: { bottom: 6 } }).setScale(1 / 6).setShadow(3, 4, '#0b0910', 0, false, true);
  }
  function icon(s, frame, used) {
    let sp;
    try { sp = new Phaser.GameObjects.Sprite(s, 0, 0, 'items', s.textures.get('items').has(frame) ? frame : 'unknown'); } catch { return null; }
    sp.setOrigin(0, 0).setScale(12 / 32);
    if (used) sp.setAlpha(0.45).setTint(0x8a8a8a);
    return sp;
  }
  // a small dark plate with the item icons (×n for a stack; names when there is room), top-left corner at x, y
  function plate(s, x, y, list, names, color, more) {
    const c = new Phaser.GameObjects.Container(s, x, y), g = new Phaser.GameObjects.Graphics(s);
    c.add(g);
    let cx = 1;
    list.forEach(it => {
      const used = !!(it.state && it.state.used), many = it.count > 1 ? '×' + it.count : '';
      const ic = icon(s, frameOf(it.def), used);
      if (ic) { ic.setPosition(cx, 0); c.add(ic); cx += 12; }
      if (names) { const t = text(s, it.def.name + many + (used ? '(已用)' : ''), used ? '#a59cb3' : '#f8f8f8', 54); t.setPosition(cx, 1); c.add(t); cx += Math.ceil(t.displayWidth) + 3; }
      else if (many) { const t = text(s, many, '#f8f8f8', 48); t.setPosition(cx - 1, 3); c.add(t); cx += Math.ceil(t.displayWidth) + 1; }
    });
    if (more > 0) { const t = text(s, '+' + more, '#f8f8f8', 48); t.setPosition(cx, 3); c.add(t); cx += Math.ceil(t.displayWidth) + 1; } // kinds left out for lack of room
    g.fillStyle(0x1d1824, 0.85).fillRoundedRect(0, -1, cx + 1, 14, 2);
    g.lineStyle(1, Phaser.Display.Color.HexStringToColor(color).color, 0.9).strokeRoundedRect(0, -1, cx + 1, 14, 2);
    c.w = cx + 1;
    return c;
  }
  // a plate no wider than maxW: with names when they fit, else icons only, else as many icons as fit and "+N"
  function fitPlate(s, list, names, color, maxW) {
    let c = plate(s, 0, 0, list, names, color);
    if (c.w <= maxW) return c;
    if (names) { c.destroy(); c = plate(s, 0, 0, list, false, color); }
    for (let n = list.length - 1; c.w > maxW && n >= 1; n--) { c.destroy(); c = plate(s, 0, 0, list.slice(0, n), false, color, list.length - n); }
    return c;
  }
  function draw() {
    const s = scene();
    if (!s || !s.add || !window.Phaser) return;
    // (the game empties its display list at the title without destroying our layer: check it is still on it)
    if (s !== ov.scene || !ov.layer || !ov.layer.scene || s.children.getIndex(ov.layer) < 0) {
      try { if (ov.layer && ov.layer.scene) ov.layer.destroy(); } catch {}
      ov.scene = s; ov.sig = '';
      ov.layer = s.add.container(0, 0).setScale(6).setDepth(1e6 - 1).setName('coop-mods');
    }
    const mode = uiMode(), marks = [];
    if (active() && anyOn() && partyOf(s).length) {
      if (s.currentBattle && BATTLE_MODES.includes(mode)) {
        // in battle: under each of the players' Pokémon on the field
        s.getPlayerField().forEach(p => {
          if (!p || !p.isActive(true)) return;
          const list = shownItems(p);
          if (!list.length) return;
          const r = p.getSprite().getBounds();
          marks.push({ id: p.id, x: Math.round(r.x / 6), y: Math.round((r.y + r.height) / 6), anchor: 'feet', list, names: false, color: ownerCss(p) });
        });
      } else if (mode === 'PARTY') {
        // party screen: on each Pokémon's row
        const h = s.ui.getHandler(), slots = (h && h.partySlots) || [];
        partyOf(s).forEach((p, i) => {
          const list = shownItems(p), slot = slots[i];
          if (!list.length || !slot || !slot.getBounds) return;
          const r = slot.getBounds();
          // the two big cards on the left (on the field): along the top edge; the rows on the right: on the level line, inside the row
          const big = r.height > 250;
          marks.push({ id: p.id, x: Math.round((big ? r.x + r.width : r.x + 90 * 6) / 6), y: Math.round((big ? r.y : r.y + 18 * 6) / 6), anchor: big ? 'card' : 'row', list, names: true, color: ownerCss(p) });
        });
      }
    }
    const sig = mode + '|' + iconReg.done.size + '|' + JSON.stringify(marks.map(m => [m.id, m.x, m.y, m.anchor, m.list.map(it => [it.key, it.count, !!(it.state && it.state.used)])]));
    if (sig === ov.sig) return;
    ov.sig = sig;
    ov.layer.removeAll(true);
    const feet = []; // plates already placed at a Pokémon's feet: [x, y, w]
    marks.forEach(m => {
      // feet: left of the sprite's feet, above the message box (at most 150 px wide). card: along the top edge of
      // the big card of a Pokémon on the field, never wider than the card (about 104 px), so that it stays off the
      // reserve rows and the option menu. row: about 66 px free between the level and the HP numbers.
      const c = fitPlate(s, m.list, m.names, m.color, m.anchor === 'feet' ? 150 : m.anchor === 'card' ? 104 : 66);
      if (m.anchor === 'feet') {
        const w = c.w, x = Math.max(2, m.x - w + 6); let y = Math.min(m.y - 15, 115);
        // two long plates would lie on top of each other: the later one goes one line up
        while (y > 30 && feet.some(f => f[1] === y && x < f[0] + f[2] && f[0] < x + w)) y -= 15;
        feet.push([x, y, w]);
        c.setPosition(x, y);
      }
      else if (m.anchor === 'card') c.setPosition(Math.max(2, m.x - c.w - 2), m.y + 1);
      else c.setPosition(m.x, m.y);
      ov.layer.add(c);
    });
  }

  // ---- the list of mods, with switches (opened from the co-op menu) ----
  let panel = null;
  const el = (tag, attrs, kids) => {
    const e = document.createElement(tag);
    Object.entries(attrs || {}).forEach(([k, v]) => { if (k === 'text') e.textContent = v; else if (k === 'onclick') e.addEventListener('click', v); else e.setAttribute(k, v); });
    (kids || []).forEach(k => k && e.appendChild(k));
    return e;
  };
  // an item's icon for the list: the mod's own picture, or the frame cut out of the game's item texture
  function iconEl(it) {
    try {
      if (it.custom && iconData[it.custom]) return el('img', { class: 'ic', src: iconData[it.custom].uri, alt: '' });
      const s = scene(), f = s && s.textures && s.textures.exists('items') ? s.textures.get('items').get(s.textures.get('items').has(it.icon) ? it.icon : 'unknown') : null;
      if (!f || !f.source || !f.source.image) return el('span', { class: 'ic' });
      const cv = el('canvas', { class: 'ic', width: ICON, height: ICON });
      cv.getContext('2d').drawImage(f.source.image, f.cutX, f.cutY, f.cutWidth, f.cutHeight, Math.floor((ICON - f.cutWidth) / 2), Math.floor((ICON - f.cutHeight) / 2), f.cutWidth, f.cutHeight);
      return cv;
    } catch { return el('span', { class: 'ic' }); }
  }
  const keysOff = e => { if (!panel) return; if (e.key === 'Escape' && e.type === 'keydown') closePanel(); e.stopImmediatePropagation(); };
  function closePanel() {
    if (!panel) return;
    panel.remove(); panel = null;
    ['keydown', 'keyup'].forEach(t => window.removeEventListener(t, keysOff, true));
  }
  function openPanel() {
    if (!document.getElementById('prsModsCss')) {
      const css = el('style', { id: 'prsModsCss' });
      css.textContent = '#prsModsMask{position:fixed;inset:0;z-index:2147483002;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center}' +
        '#prsModsCard{box-sizing:border-box;width:min(94vw,560px);max-height:92vh;overflow:auto;padding:14px 16px;border-radius:12px;background:#2b2633;color:#f1eef5;font:14px/1.5 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif;user-select:none;-webkit-user-select:none}' +
        '#prsModsCard h2{margin:0 0 2px;font-size:17px}#prsModsCard p{margin:4px 0;color:#b3abc0;font-size:12.5px}' +
        '#prsModsCard .mod{margin:10px 0;padding:10px 12px;border-radius:9px;background:#1f1b26}' +
        '#prsModsCard .head{display:flex;align-items:center;gap:10px}#prsModsCard .head b{font-size:15px;flex:1}' +
        '#prsModsCard .meta{color:#b3abc0;font-size:12px}#prsModsCard .desc{margin:4px 0 6px}' +
        '#prsModsCard ul{margin:4px 0 0;padding:0;list-style:none}#prsModsCard li{margin:5px 0;font-size:12.5px;color:#d9d3e3;display:flex;gap:8px;align-items:flex-start}' +
        '#prsModsCard li i{font-style:normal;font-weight:600}#prsModsCard li small{color:#b3abc0;font-size:11.5px}#prsModsCard li div{flex:1}' +
        '#prsModsCard .ic{flex:none;width:32px;height:32px;image-rendering:pixelated;object-fit:contain}' +
        '#prsModsCard .bag{display:flex;flex-wrap:wrap;gap:6px 14px;margin-top:4px}#prsModsCard .bag span{display:flex;align-items:center;gap:4px;font-size:12.5px}' +
        '#prsModsCard button{padding:7px 14px;border:0;border-radius:7px;background:#6d5bd0;color:#fff;font-size:14px;cursor:pointer}' +
        '#prsModsCard button.off{background:#4a4356}#prsModsCard .row{display:flex;justify-content:flex-end;margin-top:8px}' +
        '#prsModsCard .err{color:#ff8a7a;font-size:12px}';
      document.head.appendChild(css);
    }
    closePanel();
    const card = el('div', { id: 'prsModsCard' });
    const render = () => {
      card.textContent = '';
      card.appendChild(el('h2', { text: 'Mod（民间创意工坊）' }));
      card.appendChild(el('p', { text: '玩家提的点子做成的可装卸内容。只在合作房间里生效，开关记在这台设备上；关掉不影响存档，再打开时已经拿到的道具还在。' }));
      if (!order.length) card.appendChild(el('p', { text: '这个版本没有自带任何 mod。' }));
      order.forEach(id => {
        const m = mods[id], mf = m.manifest, on = isOn(id);
        const btn = el('button', { class: on ? '' : 'off', text: m.error ? '加载失败' : on ? '已开启' : '已关闭', onclick: () => { if (!m.error) { setOn(id, !isOn(id)); render(); } } });
        const list = el('ul', {}, m.items.map(k => {
          const it = items[k], t = TIER[it.tier];
          const name = el('i', { text: it.name + '（' + TIER_ZH[t] + '）' });
          name.style.color = TIER_CSS[t];
          return el('li', {}, [iconEl(it), el('div', {}, [name, el('small', { text: ' ' + KIND_ZH[it.kind] + ' · 最大携带数量 ' + it.max }), el('br'), document.createTextNode(it.description.replace(/\n/g, ''))])]);
        }));
        card.appendChild(el('div', { class: 'mod' }, [
          el('div', { class: 'head' }, [el('b', { text: mf.name || id }), btn]),
          el('div', { class: 'meta', text: 'v' + (mf.version || '?') + ' · 作者：' + (mf.author || '?') + (mf.credits ? ' · ' + mf.credits : '') }),
          el('div', { class: 'desc', text: mf.description || '' }),
          m.error ? el('div', { class: 'err', text: '这个 mod 没能加载：' + m.error.slice(0, 160) }) : list,
        ]));
      });
      // the team bag: passive items of this run (of mods that are on)
      if (active() && partyOf(scene()).length && order.some(id => mods[id].items.some(k => items[k].kind === 'passive'))) {
        const inBag = shownBag();
        card.appendChild(el('div', { class: 'mod' }, [
          el('div', { class: 'head' }, [el('b', { text: '队伍背包（被动增益）' })]),
          inBag.length ? el('div', { class: 'bag' }, inBag.map(it => el('span', {}, [iconEl(it.def), document.createTextNode(it.def.name + ' ×' + it.count + '（最多 ' + it.def.max + (noteOf(it) ? '，' + noteOf(it) : '') + '）')])))
            : el('div', { class: 'meta', text: '这一局还没有拿到被动增益道具。' }),
        ]));
      }
      card.appendChild(el('p', { text: active() ? '改了马上生效；奖励里的新道具从下一次战后奖励起出现。' : '现在没有开着的合作房间：开关先记下，开房间后生效。' }));
      card.appendChild(el('div', { class: 'row' }, [el('button', { text: '回到游戏', onclick: closePanel })]));
    };
    render();
    panel = el('div', { id: 'prsModsMask', onclick: e => { if (e.target === panel) closePanel(); } }, [card]);
    document.body.appendChild(panel);
    ['keydown', 'keyup'].forEach(t => window.addEventListener(t, keysOff, true)); // keys stay out of the game while the list is open
    return true;
  }

  setInterval(() => {
    const s = scene();
    if (!s || !s.phaseManager || !window.CoopTeam) return; // no co-op room: nothing is touched
    try {
      hookSave(s);
      if (s.seed && partyOf(s).length) {
        // another run, or this seed from an earlier point (the wave or the run's clock went back: loaded again,
        // or a new run on the same seed): take the items from the save again
        const wave = (s.currentBattle || {}).waveIndex || 0, time = Number(s.sessionPlayTime) || 0;
        if (s.seed !== heldSeed || (wave > 0 && wave < runMark.wave) || time < runMark.time) loadFor(s.seed);
        if (wave > 0) runMark.wave = wave;
        runMark.time = time;
      }
      if (anyOn()) {
        watchCombo(); hookPhases(s); hookPokemon(s); registerIcons(s);
        for (const fn of tickFns) guard('tick', () => fn(s));
      }
    } catch (e) { log('error', String(e)); }
    try { draw(); } catch (e) { log('overlay error', String(e)); }
  }, 200);

  const debugApi = {
    hooked: () => ({ ...hooked, save: !!(scene() && scene().gameData && scene().gameData.__coopMods) }),
    held: () => JSON.parse(JSON.stringify(held)),   // { pokemonId: { key: { n, s } } }
    bag: () => JSON.parse(JSON.stringify(bag)),     // { key: { n, s } }
    block: () => JSON.parse(JSON.stringify(exportBlock(scene()))), // what the next save will carry
    // partyIndex: place in the party (ignored for a passive item)
    give: (partyIndex, key, state) => give(scene().getPlayerParty()[partyIndex], key, state, 'debug'),
    take: (partyIndex, key, n) => take(scene().getPlayerParty()[partyIndex], key, n == null ? 1 : n),
    remove: (partyIndex, key) => remove(scene().getPlayerParty()[partyIndex], key),
    forceReward: keys => { debug.force = [].concat(keys); return debug.force.slice(); },
    chance: () => Object.fromEntries(Object.keys(items).map(k => { const t = TIER[items[k].tier], pool = POOL[t], same = Object.keys(items).filter(x => TIER[items[x].tier] === t); const w = x => Math.min(Number(items[x].weight) || 0, pool.cap); return [k, w(k) / (pool.total + same.reduce((a, x) => a + w(x), 0))]; })),
    icons: () => ({ packed: Object.keys(iconData).length, decoded: Object.keys(iconData).filter(k => iconData[k].ok).length, inTexture: iconReg.done.size }),
    events: () => EVENTS.slice(),
    battle: B,
  };

  // ---- engine extensions (engine/ext-*.js, see engine/EXT.md): what an extension gets ----
  const exts = {}; // name -> 'ok' | the error it failed with
  const X = {
    version: API_VERSION,
    scene, log, uiMode,
    // the tables (read them, do not write): items 'modId:itemId' -> definition; mods modId -> { manifest, items, ok, ... }
    items, mods, order,
    TIER, tierName: t => TIER_ZH[typeof t === 'number' ? t : TIER[t]] || '', tierColor: t => TIER_CSS[typeof t === 'number' ? t : TIER[t]] || '#f8f8f8', kindName: k => KIND_ZH[k] || '',
    STAT: statApi, cfg,
    isOn, anyOn, active, itemOn,
    key: (modId, itemId) => modId + ':' + itemId,
    // held items and the team bag, by item key. p: the Pokémon (null for a passive item)
    give: (p, key, state, from) => give(p, key, state, from),
    take: (p, key, n) => take(p, key, n == null ? 1 : n),
    remove: (p, key) => remove(p, key),
    count: (p, key) => (!itemOn(key) ? 0 : items[key].kind === 'passive' ? bagCount(key) : countOf(p, key)), // 0 while the item's mod is off
    state: (p, key) => { const e = items[key] && items[key].kind === 'passive' ? bag[key] : entryOf(p, key); return e ? e.s : null; },
    holders: key => (itemOn(key) ? partyOf(scene()).filter(p => holds(p, key)) : []),
    heldItems: p => shownItems(p), bagItems: () => shownBag(), // [{ key, def, state, count }] of mods that are on
    canTake,
    emit, has, listeners,
    addEvent(name) { if (!/^[a-z][A-Za-z0-9]{2,39}$/.test(name)) throw new Error('bad event name ' + name); if (!EVENTS.includes(name)) EVENTS.push(name); return name; },
    extendBattle(fns) { const ks = Object.keys(fns || {}); for (const k of ks) if (k in B) throw new Error('api.battle.' + k + ' exists already'); for (const k of ks) B[k] = fns[k]; },
    extendApi(fn) { if (typeof fn !== 'function') throw new Error('extendApi needs a function (mod, api) => ({ ... })'); apiExt.push(fn); },
    onTick(fn) { tickFns.push(fn); },
    onSwitch(fn) { switchFns.push(fn); },
    // hooks: see wrapOnce / before / after above
    wrap: (obj, method, tag, make) => wrapOnce(obj, method, tag, make), before, after, guard, protoWith, gameMethod,
    // fn(p, key, max) -> number: how many of held item `key` Pokémon p may hold (max: the item's own, or what the extension before answered)
    onMax(fn) { if (typeof fn !== 'function') throw new Error('onMax needs a function (pokemon, key, max) => number'); maxFns.push(fn); },
    maxOf: (p, key) => maxOf(p, key),
    // fn(proto, phase) once, when the first phase of that class is about to start (or now, if one already has)
    phaseClass(name, fn) { (phaseClassFns[name] = phaseClassFns[name] || []).push(fn); if (phaseProtos[name]) guard('phase class ' + name, () => fn(phaseProtos[name], null)); },
    // fn(proto) once, with the game's Pokemon class (the base of the players' and the enemies' Pokémon)
    pokemonClass(fn) { pokemonClassFns.push(fn); if (pokemonProto) guard('pokemon class', () => fn(pokemonProto)); },
    // rewards: fn(phase, options) for every reward list the game makes while a mod is on; return a new list to replace it
    onRewardOptions(fn) { rewardFns.push(fn); },
    makeOption, rng, random: B.random,
    nameOf, battle: B, turnKey, phaseNow, inBattle: () => B.inBattle(),
    frameOf: key => (items[key] ? frameOf(items[key]) : 'unknown'),
    redraw() { ov.sig = ''; },
    debug(name, fn) { if (name in debugApi) throw new Error('CoopMods.debug.' + name + ' exists already'); debugApi[name] = fn; },
  };
  window.CoopModsExt = function (name, install) {
    if (typeof name !== 'string' || !name || typeof install !== 'function') { log('extension refused: CoopModsExt(name, X => { ... })'); return false; }
    if (name in exts) return false; // injected twice
    exts[name] = 'installing';
    try { install(X); exts[name] = 'ok'; log('extension ' + name + ' installed'); return true; } catch (e) {
      exts[name] = String((e && e.stack) || e).slice(0, 400);
      log('extension ' + name + ' failed to install, skipped: ' + exts[name]);
      return false;
    }
  };

  window.CoopMods = {
    apiVersion: API_VERSION,
    manifest, define, icons, openPanel, closePanel,
    list: () => order.map(id => ({ id, name: mods[id].manifest.name, version: mods[id].manifest.version, on: isOn(id), error: mods[id].error, items: mods[id].items.slice() })),
    isOn, setOn,
    extensions: () => ({ ...exts }),
    // names of the mod items a Pokémon holds (for the phone's team sheet, host-game.js readParty)
    heldNames: p => shownItems(p).map(it => it.def.name + (it.count > 1 ? '×' + it.count : '') + (it.state && it.state.used ? '(已用)' : '')),
    // names of the passive mod items in the team bag (for the phone's team sheet, next to the game's own bag)
    bagNames: () => shownBag().map(it => it.def.name + (it.count > 1 ? '×' + it.count : '') + (noteOf(it) ? '（' + noteOf(it) + '）' : '')),
    canTake,
    tierName: X.tierName,
    // does a mod that is on refuse this move for this Pokémon? (host-game.js greys it out in 2P's pick list)
    moveBlocked(p, moveId) {
      if (!has('moveSelect')) return false;
      for (const [m, fn] of listeners('moveSelect')) { try { const no = fn({ pokemon: p, moveId }); if (typeof no === 'string' && no) return true; } catch (e) { problem(m, 'moveSelect', e); } }
      return false;
    },
    // for tests from the console; not used by the game or by mods
    debug: debugApi,
  };
  log('loader ready (interface v' + API_VERSION + ')');
})();
