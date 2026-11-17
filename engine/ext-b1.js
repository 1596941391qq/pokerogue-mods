// Engine extension of team b1: extra reward screens.
// A mod can add its own reward screens that come right after a wave's normal reward (issue #2: the 联机道具
// screen; #25 招式学习器盒; #26 进化之证). The mod says when a screen is due and what is on it; this file does
// everything that touches the game: queueing the screen behind the wave's reward phase, the list of options,
// the title on screen, the paid reroll, hiding the shop, and rolling the game's own TMs / evolution items /
// form-change items for a mod to offer.
//
// ---- For mod authors (简体中文，格式同 docs/MOD-API.md；这一段是本扩展给 mod 多加的东西) ----
//
// `api.rewardScreen(def)`：加一个「额外的奖励界面」。它排在这一层正常奖励（两位玩家都挑完）之后，
// 两位玩家照样轮流挑：先挑的人从全部选项里拿 1 个，另一位从剩下的里拿 1 个。界面上方会显示标题。
// 这个界面没有商店那一排。
//   id       小写字母、数字、短横线
//   title    显示在界面上方的标题（中文），hint 是标题下面的一行小字（可以不写）
//   count    一次出几个选项（1–8）
//   reroll   true = 左下角可以付费刷新（价格和游戏的刷新一样，从正在挑的那位玩家的钱里扣），不写 = 不能刷新
//   exclusive  true = 只要这个 mod 开着，所有 mod 道具都不再混进正常奖励，只从这种界面里出
//   when(ctx)     这一层的正常奖励排上队时问一次：返回 true 就在它后面加这个界面。ctx.wave 是层数
//   first(ctx)    谁先挑：返回 'p1' / 'p2'；不写或返回别的 = 和正常奖励一样（单数层 2P 先）
//   options(ctx)  界面要打开时问：返回这次的选项列表（数组）。每一项是一个 mod 道具的 key（`item.key`），
//                 或者 `api.gameRewards` 给的游戏道具。返回空数组 = 这次不出这个界面。
//                 ctx: wave 层数、count 要几个、round 第几轮（刷新第二位玩家的那一轮时是 2）、reroll 第几次刷新（0 = 没刷新过）、
//                 picker 现在轮到谁、random() 给 0 到 1 的数（同一局、同一层、同一次刷新永远一样）
//   opened(ctx)   界面真的打开了（有东西可挑）时调用一次；一次性的道具在这里 `item.take()`
//   emptyText     没有东西可出、这次不出界面时显示的一句话（可以不写）
//   refill        true = 轮到第二位玩家时，剩下的选项里已经没人用得上的（比如第一位刚让那只宝可梦进化了）会被拿掉，
//                 再问一次 options(ctx)（ctx.round 是 2）补上；不写 = 只拿掉、不补
// `api.gameRewards({ kinds, tier, max, who, ignoreBracelet })`：队伍里有宝可梦用得上的游戏道具，最多 max 个、互不重复。
//   kinds: 'tm' 招式学习器、'evolution' 进化道具、'form' 形态变化道具（超级石、极巨菇菇也在这一类），可以写数组；
//   tier: 'COMMON' / 'GREAT' / 'ULTRA' / 'ROGUE'，游戏给这个道具定的品质；
//   who: 'p1' / 'p2' = 只看这位玩家的宝可梦用不用得上，不写 = 两位玩家的都算；
//   ignoreBracelet: true = 没有超级手环 / 极巨腕带时，超级石和极巨菇菇也算。
//   返回的是游戏自己的对象，只能原样放进 options 的返回值里。只在奖励阶段里能用（options / when 里），别处返回空数组。
// `api.modItems()`：所有开着的 mod 的道具，`[{ key, mod, id, name, tier, kind, max, canTake(who) }]`。
// `B.rewardPicker()`：现在奖励界面轮到谁挑，'p1' / 'p2'；不在奖励界面时是 null。
// `B.sameReward(a, b)`：`api.gameRewards` 给的两个道具是不是同一个（同一个招式学习器、同一块石头）。
CoopModsExt('b1', X => {
  const T = 'b1', TAG = '__b1'; // TAG on a reward phase: { id, wave, rr, n?, copy? } = one of our extra screens
  const screens = {}, ids = []; // id -> definition (with .mod), in the order they were registered
  let started = new WeakMap(); // Battle object -> Set of screen ids that have started in that battle
  const dbg = { force: new Set(), wave: null, last: null };
  let rewardProto = null, rawOptions = null; // SelectModifierPhase.prototype / its getModifierTypeOptions before the extensions and the core wrapped it
  let rawStart = null, lastRerolls = 0; // its start before we wrapped it / the reroll count of the last reward screen that started
  let likeOption = null; // any option the game made (for X.makeOption)
  let ownsOffer = false; // we switched X.cfg.normalOffer off

  const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const isReward = ph => !!ph && ph.phaseName === 'SelectModifierPhase';
  const tagOf = ph => (isReward(ph) && ph[TAG] && typeof ph[TAG] === 'object' ? ph[TAG] : null);
  const coopOf = ph => (ph && ph.__coop && typeof ph.__coop === 'object' ? ph.__coop : null); // host-team.js's tag (true on untagged phases)
  const defOf = ph => { const t = tagOf(ph), d = t && screens[t.id]; return d && X.isOn(d.mod) ? d : null; };
  const current = () => { try { return X.scene().phaseManager.getCurrentPhase(); } catch { return null; } };
  const waveNow = () => (dbg.wave != null ? dbg.wave : ((X.scene().currentBattle || {}).waveIndex) || 0);
  const other = w => (w === 'p1' ? 'p2' : 'p1');
  const teamCount = w => { try { return window.CoopTeam.count(w); } catch { return 1; } };
  const settings = def => ({ guaranteedModifierTypeOptions: [], fillRemaining: false, allowLuckUpgrades: false, rerollMultiplier: def && def.reroll ? undefined : -1 });

  // ---- what mods get ----
  const TIERS = ['COMMON', 'GREAT', 'ULTRA', 'ROGUE', 'MASTER'];
  const KINDS = { tm: ['TM_COMMON', 'TM_GREAT', 'TM_ULTRA'], evolution: ['EVOLUTION_ITEM', 'RARE_EVOLUTION_ITEM'], form: ['FORM_CHANGE_ITEM', 'RARE_FORM_CHANGE_ITEM'] };
  const ACCESS = ['MegaEvolutionAccessModifier', 'GigantamaxAccessModifier']; // 超级手环, 极巨腕带
  const hash = str => { let h = 2166136261; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
  // one real reward option of that rarity from the game's own generator (the pool a normal reward uses), or null
  function rollOne(tier) {
    const fake = Object.create(rewardProto);
    fake.__coop = null; fake[TAG] = null; // not a co-op round, not one of ours: nobody's offer or swap applies
    fake.modifierTiers = undefined; fake.rerollCount = 0; fake.isCopy = false;
    fake.customModifierSettings = { guaranteedModifierTiers: [tier], allowLuckUpgrades: false };
    const list = rawOptions.call(fake, 1);
    const o = Array.isArray(list) ? list[0] : null;
    return o && o.type ? o : null;
  }
  // The game works out what every entry of the reward pool weighs when a reward screen starts, from the party and
  // the items of that moment, and keeps it until the next screen. An entry it found nothing for then (a mega stone
  // while nobody could use one, with another Pokémon already holding a stone) weighs 0 and cannot be rolled later.
  // This makes the game weigh the pool again now: the first lines of its own start(), stopped before the screen.
  const STOP = {};
  function reweigh(rerolls) {
    if (!rawStart || !rewardProto) return false;
    const s = X.scene(), fake = Object.create(rewardProto), had = own(s, 'reroll'), was = s.reroll;
    fake.__coop = null; fake[TAG] = null;
    fake.rerollCount = Math.max(0, Number(rerolls) || 0); fake.isCopy = false; fake.modifierTiers = undefined; fake.customModifierSettings = undefined;
    fake.isPlayer = () => true;
    fake.updateSeed = () => {}; // not a new screen: the wave's seed stays as it is
    fake.getModifierCount = fake.getModifierTypeOptions = () => { throw STOP; }; // what start() does right after weighing
    try { rawStart.call(fake); } catch (e) { if (e === STOP) return true; throw e; } finally { if (had) s.reroll = was; else delete s.reroll; }
    return false;
  }
  const rewardKey = o => o.type.id + ':' + (o.type.moveId != null ? o.type.moveId : o.type.evolutionItem != null ? o.type.evolutionItem : o.type.formChangeItem != null ? o.type.formChangeItem : o.type.name);
  // Game items somebody in the party can use, found by rolling the game's generators (which only make what the
  // party can use). Own random stream by wave and arguments: the same call gives the same list after a reload,
  // and the game's random numbers are where they were afterwards.
  function gameRewards(spec) {
    const out = [];
    const o = spec || {}, tier = TIERS.indexOf(o.tier), max = Math.max(1, Math.min(Math.floor(Number(o.max) || 8), 24));
    const want = [].concat(o.kinds || []).reduce((a, k) => a.concat(KINDS[k] || []), []);
    const s = X.scene();
    if (tier < 0 || tier > 3 || !want.length || !rewardProto || !rawOptions || !s || !s.currentBattle || typeof s.executeWithSeedOffset !== 'function') return out;
    const who = o.who === 'p1' || o.who === 'p2' ? o.who : null;
    const weigh = want.some(id => !KINDS.tm.includes(id)), offset = 7000 + (hash([tier, want.join(), o.ignoreBracelet ? 1 : 0, who || ''].join('|')) % 9000);
    const seen = new Set(), quiet = console.log, hadGm = own(s, 'getModifiers'), gm = s.getModifiers, hadGp = own(s, 'getPlayerParty'), gp = s.getPlayerParty;
    console.log = () => {}; // the game logs twice per roll
    try {
      // one player's Pokémon only: for the length of these rolls the party the generators are given is theirs
      if (who && window.CoopTeam && typeof gp === 'function') s.getPlayerParty = function () {
        const all = gp.apply(this, arguments);
        return Array.isArray(all) ? all.filter(p => window.CoopTeam.ownerOf(p) === who) : all;
      };
      // the game only offers a mega stone / Max Mushrooms when the team has the bracelet / band; the stones work
      // without it. For the length of these rolls the two "have you got it" questions are answered yes.
      if (o.ignoreBracelet && typeof gm === 'function') s.getModifiers = function (cls) {
        const r = gm.apply(this, arguments);
        return Array.isArray(r) && !r.length && cls && ACCESS.includes(cls.name) ? [{}] : r;
      };
      s.executeWithSeedOffset(() => {
        if (weigh) reweigh(0); // evolution and form items: by the party as it is now (and as the two lines above show it)
        for (let i = 0; i < 400 && out.length < max; i++) {
          const opt = rollOne(tier);
          if (!opt || !want.includes(opt.type.id)) continue;
          const k = rewardKey(opt);
          if (!seen.has(k)) { seen.add(k); out.push(opt); }
        }
      }, offset, s.waveSeed);
    } catch (e) {
      console.log = quiet;
      X.log('b1: rolling game rewards failed (' + String(e).slice(0, 120) + ')'); // e.g. no reward screen yet in this session
    } finally {
      console.log = quiet;
      if (hadGm) s.getModifiers = gm; else delete s.getModifiers;
      if (hadGp) s.getPlayerParty = gp; else delete s.getPlayerParty;
      // and the weights go back to what the game itself would have for the real party and items
      if (weigh) try { s.executeWithSeedOffset(() => { reweigh(lastRerolls); }, offset, s.waveSeed); } catch (e) { X.log('b1: weighing the reward pool again failed (' + String(e).slice(0, 120) + ')'); }
    }
    if (out[0]) likeOption = out[0];
    return out;
  }
  const modItems = () => Object.keys(X.items).filter(X.itemOn).map(key => {
    const it = X.items[key];
    return { key, mod: it.mod, id: it.id, name: it.name, tier: it.tier, kind: it.kind, max: it.max, canTake: who => X.canTake(key, who) };
  });
  function rewardScreen(mod, def) {
    if (!def || !/^[a-z0-9][a-z0-9-]{1,39}$/.test(def.id || '')) throw new Error('rewardScreen: id must be lowercase letters, digits and -');
    const id = def.id;
    if (screens[id]) throw new Error('rewardScreen ' + id + ' defined twice');
    if (!def.title || typeof def.options !== 'function' || typeof def.when !== 'function') throw new Error('rewardScreen ' + id + ': title, when(ctx) and options(ctx) are required');
    const count = Math.floor(Number(def.count));
    if (!(count >= 1 && count <= 8)) throw new Error('rewardScreen ' + id + ': count must be a whole number from 1 to 8');
    screens[id] = { id, mod: mod.id, title: String(def.title), hint: def.hint ? String(def.hint) : '', count, reroll: !!def.reroll, exclusive: !!def.exclusive,
      when: def.when, first: typeof def.first === 'function' ? def.first : null, options: def.options, opened: typeof def.opened === 'function' ? def.opened : null,
      emptyText: def.emptyText ? String(def.emptyText) : '', refill: !!def.refill };
    ids.push(id);
    return id;
  }
  X.extendApi((mod, api) => ({ rewardScreen: def => rewardScreen(mod, def), gameRewards, modItems }));
  X.extendBattle({
    rewardPicker: () => { const c = coopOf(current()); return isReward(current()) && c && (c.picker === 'p1' || c.picker === 'p2') ? c.picker : null; },
    // are two results of api.gameRewards the same item (the same TM, the same stone)?
    sameReward: (a, b) => !!(a && b && a.type && b.type) && X.guard('b1 sameReward', () => rewardKey(a) === rewardKey(b), false),
  });

  // mod items leave the normal reward while a mod with an `exclusive` screen is on (issue #2)
  function syncOffer() {
    const want = ids.some(id => screens[id].exclusive && X.isOn(screens[id].mod));
    if (want && X.cfg.normalOffer) { X.cfg.normalOffer = false; ownsOffer = true; X.log('b1: mod items only on their own reward screen now (normal offer off)'); }
    else if (!want && ownsOffer) { X.cfg.normalOffer = true; ownsOffer = false; X.log('b1: normal offer of mod items back on'); }
  }
  // A mod is switched off. From then on none of the wraps below is reached (the core calls the game's own
  // methods directly), so what this file has put into the game has to come out here:
  // - its screens that are still waiting in the queue. Left there, each would start as the game's own reward
  //   screen with an empty list: the shop and nothing else, once per player (seen on the rig);
  // - the title of a screen of its that is up right now (the title is taken off in the wrap of clear(); left
  //   there it stays over the shop row of every later reward screen).
  // A screen that is up stays up as the game's own: what is on it can still be taken.
  function modOff(modId) {
    const s = X.scene(), pm = s && s.phaseManager;
    if (!pm) return;
    const mine = p => { const t = tagOf(p), d = t && screens[t.id]; return !!d && d.mod === modId; };
    let n = 0;
    if (typeof pm.tryRemovePhase === 'function') while (n < 24 && pm.tryRemovePhase('SelectModifierPhase', mine)) n++;
    if (n) X.log('b1: mod ' + modId + ' switched off, ' + n + ' waiting screen(s) of it taken out of the queue');
    const h = ((s.ui && s.ui.handlers) || []).find(x => x && x.__b1Title);
    if (h && !defOf(current())) eraseTitle(h); // (not the title of a screen whose mod is still on)
  }
  X.onSwitch((modId, on) => X.guard('b1 switch', () => { syncOffer(); if (!on) modOff(modId); }));

  // ---- queueing: an extra screen goes right behind the wave's reward phase, the same way that one was queued ----
  // (so everything the normal reward spawns - the second player's round, a TM's learn-move phase and its copy,
  // a reroll - runs before it, and the next battle after it)
  const isBase = ph => isReward(ph) && !ph.isCopy && !ph.rerollCount && !ph[TAG] && !!coopOf(ph) && coopOf(ph).round === 1;
  function queueExtras(pm, add) {
    const s = X.scene(), b = s.currentBattle;
    if (!b) return;
    const done = started.get(b), wave = waveNow();
    for (const id of ids) {
      const def = screens[id];
      if (!X.isOn(def.mod) || (done && done.has(id))) continue;
      if (pm.hasPhaseOfType('SelectModifierPhase', p => !!p[TAG] && p[TAG].id === id)) continue;
      const due = dbg.force.has(id) || X.guard('b1 when ' + id, () => !!def.when({ wave }), false);
      if (!due) continue;
      const ph = pm.create('SelectModifierPhase', 0, undefined, settings(def), false);
      ph[TAG] = { id, wave, rr: 0 };
      add.call(pm, ph);
      X.log('b1: screen ' + id + ' queued behind the reward of wave ' + wave);
    }
  }
  function hookManager(s) {
    const pm = s.phaseManager;
    for (const method of ['pushPhase', 'unshiftPhase']) {
      X.wrap(pm, method, T, orig => function (...phases) {
        const r = orig.apply(this, phases);
        X.guard('b1 queue', () => { if (ids.length && phases.some(isBase)) queueExtras(this, orig); });
        return r;
      });
    }
    // phases made while one of our screens is up: the game's copy (kept while a TM is being learned) and
    // host-team.js's second round stay ours; a reroll (which the game makes as an ordinary random reward)
    // becomes a new list of the same screen
    X.wrap(pm, 'create', T, orig => function (name, ...args) {
      if (name !== 'SelectModifierPhase') return orig.call(this, name, ...args);
      let tag = null;
      X.guard('b1 create', () => {
        const cur = this.getCurrentPhase(), t = tagOf(cur);
        if (!t) return;
        if (args[3] === true) tag = { id: t.id, wave: t.wave, rr: t.rr || 0, copy: true, refilled: !!t.refilled };
        else if (args[0] > 0) {
          tag = { id: t.id, wave: t.wave, rr: (t.rr || 0) + 1, n: (cur.typeOptions || []).length };
          args[1] = undefined;
          args[2] = settings(screens[t.id]);
        }
      });
      const ph = orig.call(this, name, ...args);
      if (tag && ph) ph[TAG] = tag;
      return ph;
    });
  }

  // ---- a screen starts ----
  function contextFor(ph, tag, def, c, n) {
    const s = X.scene(), round = c.round === 2 ? 2 : 1;
    return { wave: tag.wave, count: n, round, reroll: tag.rr || 0, picker: c.picker, random: X.rng([s.seed, tag.wave, 'b1', def.id, round, tag.rr || 0].join(':')) };
  }
  // what a mod's options(ctx) returned -> reward options the screen can show, at most n, none twice, none of `have`
  function toOptions(list, n, have) {
    const opts = [], seen = new Set((have || []).map(optKey));
    for (const x of Array.isArray(list) ? list : []) {
      if (opts.length >= n) break;
      let opt = null;
      if (typeof x === 'string') { if (X.itemOn(x) && !seen.has('mod:' + x)) opt = X.makeOption(likeOption, x, 0); }
      else if (x && typeof x === 'object' && x.type && typeof x.type.name === 'string' && !seen.has(optKey(x))) opt = x;
      if (opt) { seen.add(optKey(opt)); opts.push(opt); }
    }
    return opts;
  }
  const optKey = o => (o.type.__coopMod ? 'mod:' + o.type.__coopMod : 'game:' + rewardKey(o));
  // can anybody in the party still use this option? (a game item that goes on a Pokémon says so itself)
  function usable(opt) {
    const type = opt && opt.type;
    if (!type) return false;
    if (type.__coopMod) return X.itemOn(type.__coopMod);
    if (typeof type.selectFilter !== 'function') return true;
    return X.scene().getPlayerParty().some(p => { try { return type.selectFilter(p) === null; } catch { return true; } });
  }
  // 'go': show it; 'skip': nothing to show, end the phase without opening anything
  function prepare(ph, tag) {
    const def = defOf(ph), c = coopOf(ph), s = X.scene();
    if (!def || !c) return 'skip'; // its mod was switched off meanwhile, or host-team.js did not tag it
    if (ph.isCopy) { // a copy shows the list it was made with (the second round: what the first player left)
      const cs = ph.customModifierSettings, list = cs && Array.isArray(cs.guaranteedModifierTypeOptions) ? cs.guaranteedModifierTypeOptions : [];
      // what nobody can use any more is taken off (the first player's pick may have evolved the Pokémon it was for)
      let rest = list.filter(usable);
      if (c.round === 2 && !tag.refilled) {
        tag.refilled = true;
        if (def.refill && rest.length < list.length) {
          const more = X.guard('b1 refill ' + def.id, () => def.options(contextFor(ph, tag, def, c, list.length)), []);
          rest = rest.concat(toOptions(more, list.length - rest.length, rest).filter(usable));
        }
      }
      if (cs && (rest.length !== list.length || rest.some((o, i) => o !== list[i]))) { // (a refilled list has the old length)
        X.log('b1: screen ' + def.id + ': ' + list.filter(o => !rest.includes(o)).length + ' of the ' + list.length + ' left can no longer be used; now: ' + (rest.map(o => o.type.name).join(' | ') || 'nothing'));
        cs.guaranteedModifierTypeOptions = rest;
      }
      tag.empty = !rest.length;
      return rest.length ? 'go' : 'skip'; // no shop on these screens: an empty round has nothing
    }
    const first = !tag.rr;
    if (first && s.currentBattle) { // from here on this battle has had this screen (looked at when another reward phase is queued)
      let done = started.get(s.currentBattle);
      if (!done) started.set(s.currentBattle, done = new Set());
      done.add(def.id);
      dbg.force.delete(def.id);
    }
    if (first) {
      let who = def.first ? X.guard('b1 first ' + def.id, () => def.first({ wave: tag.wave }), null) : null;
      if (who !== 'p1' && who !== 'p2') who = c.picker;
      if ((who === 'p1' || who === 'p2') && !teamCount(who) && teamCount(other(who))) who = other(who); // nobody to give an item to
      if (who === 'p1' || who === 'p2') c.picker = who;
    }
    const n = first ? def.count : Math.max(1, Math.min(Number(tag.n) || def.count, 8));
    const ctx = contextFor(ph, tag, def, c, n);
    const opts = toOptions(X.guard('b1 options ' + def.id, () => def.options(ctx), []), n);
    tag.empty = !opts.length;
    if (!opts.length) return 'skip';
    ph.customModifierSettings = settings(def);
    ph.customModifierSettings.guaranteedModifierTypeOptions = opts; // the game shows a set list as it is
    tag.opts = opts;
    X.log('b1: screen ' + def.id + ' wave ' + tag.wave + (tag.rr ? ' reroll ' + tag.rr : '') + ', ' + (c.picker === 'p1' ? '1P' : '2P') + ' picks' + (c.round === 2 ? ' (second round)' : ' first') + ': ' + opts.map(o => o.type.name).join(' | '));
    if (first && def.opened) X.guard('b1 opened ' + def.id, () => def.opened(ctx));
    return 'go';
  }
  function skip(ph) {
    const c = coopOf(ph), tag = tagOf(ph) || {}, def = defOf(ph);
    if (c) c.ended = true; // host-team.js: no second round for a screen that never opened
    X.log('b1: screen ' + tag.id + ' has nothing to show, skipped');
    // tell the players why nothing comes up (shown right after this phase)
    X.guard('b1 skip text', () => {
      const text = !def || !tag.empty ? '' : ph.isCopy ? '「' + def.title + '」里没有剩下能用的道具了。' : def.emptyText;
      if (text) X.scene().phaseManager.queueMessage(text, 1500); // stays up a moment after it is written out, no button needed
    });
    return ph.end();
  }
  X.phaseClass('SelectModifierPhase', proto => {
    // the two methods as they were before the core or any extension wrapped them (whatever the install order)
    if (proto !== rewardProto) { rewardProto = proto; rawOptions = X.gameMethod(proto, 'getModifierTypeOptions'); rawStart = X.gameMethod(proto, 'start'); }
    X.wrap(proto, 'start', T, orig => function () {
      const tag = tagOf(this);
      if (!this.isCopy) lastRerolls = Number(this.rerollCount) || 0; // (a copy keeps the weights of the screen it copies)
      if (!tag) return orig.apply(this, arguments);
      const what = X.guard('b1 screen start', () => prepare(this, tag), 'skip');
      return what === 'go' ? orig.apply(this, arguments) : skip(this);
    });
    // the list on screen is the one prepared above, whatever was added to it on the way (金色精灵球, 银色之羽: issue #2)
    X.before(proto, 'resetModifierSelect', T, self => {
      const tag = tagOf(self);
      if (!tag || self.isCopy || !Array.isArray(tag.opts) || !Array.isArray(self.typeOptions)) return;
      if (self.typeOptions.length !== tag.opts.length || self.typeOptions.some((o, i) => o !== tag.opts[i])) {
        X.log('b1: screen ' + tag.id + ': the list was changed on the way (' + self.typeOptions.length + ' options), put back to its ' + tag.opts.length);
        self.typeOptions = tag.opts.slice();
      }
    });
    // price of the reroll: the game's own (never the Lock Capsule's price: the screen has its own odds), or none
    X.wrap(proto, 'getRerollCost', T, orig => function () {
      if (!tagOf(this)) return orig.apply(this, arguments);
      const def = defOf(this);
      return def && def.reroll ? orig.call(this, false) : -1;
    });
  });

  // ---- on screen: the title, and no shop row ----
  function label(s, str, color, size) {
    return new Phaser.GameObjects.Text(s, 0, 0, str, { fontFamily: 'emerald', fontSize: size, color, padding: { bottom: 6 } }).setScale(1 / 6).setShadow(3, 4, '#0b0910', 0, false, true);
  }
  function eraseTitle(h) {
    const t = h.__b1Title;
    h.__b1Title = null;
    if (t && t.scene) t.destroy();
  }
  function drawTitle(h, def) {
    const s = X.scene();
    eraseTitle(h);
    if (!window.Phaser || !h.modifierContainer) return;
    const c = new Phaser.GameObjects.Container(s, 160, -164); // the band the shop row normally uses; UI coordinates, y up from the bottom edge
    const title = label(s, '— ' + def.title + ' —', '#f8d038', 96).setOrigin(0.5, 0);
    const hint = def.hint ? label(s, def.hint, '#f8f8f8', 54).setOrigin(0.5, 0) : null;
    const w = Math.ceil(Math.max(title.displayWidth, hint ? hint.displayWidth : 0)) + 14, th = Math.ceil(title.displayHeight);
    const hgt = th + (hint ? Math.ceil(hint.displayHeight) : 0) + 3;
    const g = new Phaser.GameObjects.Graphics(s);
    g.fillStyle(0x1d1824, 0.88).fillRoundedRect(-w / 2, 0, w, hgt, 3);
    g.lineStyle(1, 0xf8d038, 0.9).strokeRoundedRect(-w / 2, 0, w, hgt, 3);
    title.setPosition(0, 1);
    c.add([g, title]);
    if (hint) { hint.setPosition(0, th); c.add(hint); }
    h.modifierContainer.add(c);
    h.__b1Title = c;
    c.setAlpha(0);
    s.tweens.add({ targets: c, alpha: 1, duration: 300 });
  }
  // six options are 40 px apart and a TM's full name is twice that: under the icon only the move's name
  // (the name box above the description still shows the full name of the option the cursor is on)
  function shortLabels(h) {
    if (!Array.isArray(h.options) || h.options.length < 5) return;
    for (const o of h.options) {
      const name = o && o.modifierTypeOption && o.modifierTypeOption.type && o.modifierTypeOption.type.name, i = typeof name === 'string' ? name.lastIndexOf(' - ') : -1;
      if (i > 0 && o.itemText && typeof o.itemText.setText === 'function') o.itemText.setText(name.slice(i + 3));
    }
  }
  const ballsClosed = h => (h.options || []).some(o => o && o.pb && o.pb.scene && o.pb.frame && !/_open$/.test(String(o.pb.frame.name)));
  function hookScreen(s) {
    const h = ((s.ui && s.ui.handlers) || []).find(x => x && x.constructor && x.constructor.name === 'ModifierSelectUiHandler');
    if (!h) return;
    X.wrap(h, 'show', T, orig => function (args) {
      const def = defOf(current());
      if (!this.active) this.__b1Hold = null; // a new screen: new balls to wait for (see processInput below)
      if (!def || this.active || !Array.isArray(args) || args.length !== 4) return orig.apply(this, arguments);
      // the handler asks the game mode once, right at the start of show(), whether there is a shop
      let back = null;
      X.guard('b1 no shop', () => {
        const gm = X.scene().gameMode, had = own(gm, 'getShopStatus'), prev = gm.getShopStatus;
        gm.getShopStatus = () => false;
        back = () => { if (had) gm.getShopStatus = prev; else delete gm.getShopStatus; };
      });
      this.__b1Hold = null;
      let r;
      try { r = orig.apply(this, arguments); } finally { if (back) X.guard('b1 shop back', back); }
      if (r) X.guard('b1 title', () => { drawTitle(this, def); shortLabels(this); });
      return r;
    });
    X.wrap(h, 'clear', T, orig => function () {
      X.guard('b1 title off', () => eraseTitle(this));
      return orig.apply(this, arguments);
    });
    // The game takes input a moment before the last ball has opened, and each option still has a timer that
    // opens its ball. Leaving the screen in that moment (a reroll, a pick, a skip) destroys the options under
    // those timers; the timer then throws inside the game loop and the game stands still (seen on the game's
    // own reward screen as well, with every mod off: notes/requests-b1.md). While a mod is on, 确认 and 取消 wait
    // on every reward screen (ours and the game's own) until every ball is open, at most 3 s after the first
    // press that came too early. With every mod off this wrap is not reached and the game is as it was.
    X.wrap(h, 'processInput', T, orig => function (button) {
      if ((button === 5 || button === 6) && this.awaitingActionInput && isReward(current())) {
        const early = X.guard('b1 balls', () => {
          if (!ballsClosed(this)) return false;
          if (this.__b1Hold == null) this.__b1Hold = Date.now();
          return Date.now() - this.__b1Hold < 3000;
        }, false);
        if (early) return false;
      }
      return orig.apply(this, arguments);
    });
  }

  X.onTick(s => { syncOffer(); if (!ids.length) return; hookManager(s); hookScreen(s); });

  // ---- for tests (CoopMods.debug.*) ----
  X.debug('b1Force', list => { dbg.force = new Set([].concat(list || [])); return [...dbg.force]; }); // these screens come with the next reward, whatever when() says
  X.debug('b1Wave', n => { dbg.wave = n == null ? null : Number(n); return dbg.wave; }); // the wave number the mods are told (null: the real one)
  X.debug('b1NewBattle', () => { started = new WeakMap(); return true; }); // forget which screens this battle has had
  X.debug('b1Rewards', spec => gameRewards(spec).map(o => [o.type.id, o.type.tier, o.type.name]));
  X.debug('b1Offer', v => { if (v != null) X.cfg.normalOffer = !!v; return X.cfg.normalOffer; }); // (the next tick puts it back)
  // what a screen's options(ctx) gives, without opening anything: [[key or game id, tier, name], ...]
  X.debug('b1Options', (id, wave, n, rr, round) => {
    const def = screens[id], s = X.scene();
    if (!def) return null;
    const w = wave == null ? waveNow() : wave, r = round === 2 ? 2 : 1;
    const ctx = { wave: w, count: n || def.count, round: r, reroll: rr || 0, picker: 'p1', random: X.rng([s.seed, w, 'b1', id, r, rr || 0].join(':')) };
    return toOptions(def.options(ctx), ctx.count).map(o => [o.type.__coopMod || o.type.id, o.type.tier, o.type.name]);
  });
  X.debug('b1State', () => {
    const s = X.scene(), pm = s.phaseManager, ph = pm.getCurrentPhase(), h = s.ui.getHandler(), c = coopOf(ph), b = s.currentBattle;
    const queued = []; try { for (const lv of pm.phaseQueue.levels) for (const p of lv) if (isReward(p)) queued.push(p[TAG] ? p[TAG].id + (p[TAG].copy ? '(copy)' : '') : 'normal'); } catch {}
    return {
      screens: ids.slice(), normalOffer: X.cfg.normalOffer, wave: waveNow(), queued, started: b && started.get(b) ? [...started.get(b)] : [],
      phase: ph && ph.phaseName, tag: tagOf(ph) ? { id: ph[TAG].id, rr: ph[TAG].rr, n: ph[TAG].n, copy: !!ph[TAG].copy } : null,
      coop: c ? { round: c.round, picker: c.picker, set: !!c.set } : null,
      options: isReward(ph) && Array.isArray(ph.typeOptions) ? ph.typeOptions.map(o => [o.type.__coopMod || o.type.id, o.type.tier, o.type.name]) : null,
      cost: isReward(ph) && Array.isArray(ph.typeOptions) ? ph.getRerollCost(false) : null,
      ui: h && h.constructor.name === 'ModifierSelectUiHandler' ? { options: h.options.length, shop: h.shopOptionsRows.map(r => r.length), rerollCost: h.rerollCost, title: !!(h.__b1Title && h.__b1Title.scene), row: h.rowCursor, cursor: h.cursor } : null,
    };
  });
});
