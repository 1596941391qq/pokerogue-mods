// Engine extension of team f: what 光之黏土 (#8) and 防尘帐篷 (#18) need from the game.
// It knows no item: it turns four decisions of the game into questions a mod may answer.
//
// ---- for mod authors (接口版本 2, added by this extension; the text for docs/MOD-API.md) ----
// 事件（都用 api.on 接）：
//   screenSet     一只宝可梦用招式架起光墙、反射壁或极光幕的那一刻（还没架起来）。
//                 收到 pokemon（用招式的宝可梦）、screen（'lightScreen' 光墙 / 'reflect' 反射壁 / 'auroraVeil' 极光幕）、
//                 turns（现在要持续几回合，原版是 5）、moveId、then(fn)。
//                 返回数字 = 改成持续这么多回合（至少 1）。几个处理函数依次接着算。
//                 then(fn)：真的架起来之后再做的事，fn 收到 { turns }。这一边已经有同一种壁时招式不会生效，fn 就不会被调用，
//                 所以提示文字写在 then 里。「换场」把壁搬到对面时不会触发这个事件。
//   weatherDamage 沙暴、冰雹在回合结束时准备伤害场上的宝可梦之前，每只问一次。
//                 收到 pokemon、weather（'sandstorm' 沙暴 / 'hail' 冰雹）。返回 true = 这只这回合不受天气伤害
//                 （不扣血，也不出现「沙暴袭击了××」那行字）。本来就不怕这种天气的宝可梦也会被问到。
//   powderMove    一个粉末类招式（毒粉、麻痹粉、催眠粉、蘑菇孢子、棉孢子、粉尘、魔法粉）要对一只宝可梦生效之前。
//                 收到 user（用招式的）、target（被瞄准的）、moveId、redirect（false）。
//                 返回 true = 对 target 没有效果（和草属性宝可梦一样，显示游戏自己的「对××没有效果」）。
//                 愤怒粉：对手用了愤怒粉、target 要出单体招式时也会来问一次，这时 redirect 是 true，user 是用愤怒粉的对手，
//                 返回 true = target 的招式不会被愤怒粉吸过去。
//   effectSpore   一只宝可梦用接触类招式打中了特性是「孢子」的宝可梦，特性要判定之前。
//                 收到 pokemon（出招的）、holder（有孢子特性的）。返回 true = 这一下孢子特性不发动。
// 后三个事件是「问一句、答一句」：游戏在选招界面显示效果、AI 估算时也会来问，会被问很多次。
// 处理函数里只回答，不要发消息、不要改任何状态。有任何一个处理函数回答 true 就算 true。
// -------------------------------------------------------------------------------------------
CoopModsExt('f', X => {
  const POWDER_MOVE = 2048;   // MoveFlags.POWDER_MOVE (1 << 11)
  const TARGET_USER = 0;      // MoveTarget.USER
  const EFFECT_SPORE = 27, OVERCOAT = 142; // AbilityId
  const RAGE_POWDER = 476;    // MoveId
  const SCREENS = { LIGHT_SCREEN: 'lightScreen', REFLECT: 'reflect', AURORA_VEIL: 'auroraVeil' }; // ArenaTagType -> name for mods
  const WEATHERS = { 3: 'sandstorm', 4: 'hail' }; // WeatherType of the two damaging weathers

  X.addEvent('screenSet');
  X.addEvent('weatherDamage');
  X.addEvent('powderMove');
  X.addEvent('effectSpore');

  // what the hooks did, for the rig (CoopMods.debug.f())
  const seen = { hooks: {}, screenSet: 0, screenChanged: 0, weatherPhases: 0, weatherShadowed: 0, weatherPasses: [], weatherSkipped: 0, powderAsked: 0, powderBlocked: 0, redirectAsked: 0, redirectBlocked: 0, sporeAsked: 0, sporeBlocked: 0 };
  X.debug('f', () => JSON.parse(JSON.stringify(seen)));

  // yes/no question: true when any listener answers true. A listener that throws is logged and counts as no answer.
  function askYes(name, ev) {
    let yes = false;
    for (const [mod, fn] of X.listeners(name)) {
      if (X.guard('f ' + name + ' listener of ' + (mod && mod.id), () => fn(ev) === true, false)) yes = true;
    }
    return yes;
  }

  // ---- 1. screens: Arena.addTag(tagType, turnCount, sourceMove, sourceId, side = BOTH, quiet = false) ----
  // One call per screen a move puts up; the tag, its maxDuration, the arena flyout and the save all take the
  // number from this call. Court Change re-adds a screen with quiet = true and its remaining turns: left alone.
  function hookArena(proto) {
    return X.wrap(proto, 'addTag', 'f', orig => function (tagType, turnCount, sourceMove, sourceId, side, quiet) {
      let args = arguments; const thens = []; let turns = turnCount;
      X.guard('f screenSet', () => {
        const screen = SCREENS[tagType];
        if (!screen || quiet || !(turnCount > 0) || !X.has('screenSet')) return;
        const s = X.scene(), src = s && s.getPokemonById ? s.getPokemonById(sourceId) : null;
        if (!src) return;
        seen.screenSet++;
        for (const [mod, fn] of X.listeners('screenSet')) {
          X.guard('f screenSet listener of ' + (mod && mod.id), () => {
            const mine = [];
            const r = fn({ pokemon: src, screen, turns, moveId: sourceMove == null ? null : sourceMove, then: f => { if (typeof f === 'function') mine.push(f); } });
            if (typeof r === 'number' && isFinite(r)) turns = Math.max(1, Math.floor(r)); // 0 or less would mean "for ever" in this game
            thens.push(...mine);
          });
        }
        if (turns !== turnCount) { args = Array.prototype.slice.call(arguments); args[1] = turns; seen.screenChanged++; }
      });
      const added = orig.apply(this, args);
      // false: the side had this screen already (or the type is unknown): nothing was put up, nothing to tell
      if (added && thens.length) for (const f of thens) X.guard('f screenSet then', () => f({ turns }));
      return added;
    });
  }

  // ---- 2. weather damage: WeatherEffectPhase.start() ----
  // start() calls this.executeForAll three times: (1) abilities that suppress the weather, (2) the damage loop,
  // both synchronously, and (3) end-of-weather abilities from the callback of the weather message, later.
  // While start() runs, the phase gets its own executeForAll that leaves the protected Pokémon out of call (2).
  // When (1) finds the weather suppressed there is no second synchronous call and nothing is filtered.
  X.phaseClass('WeatherEffectPhase', proto => {
    seen.hooks.weather = X.wrap(proto, 'start', 'f', orig => function () {
      const self = this; let shadow = null, hadOwn = false, prev;
      X.guard('f weatherDamage', () => {
        seen.weatherPhases++;
        if (!X.has('weatherDamage')) return;
        const s = X.scene(), w = s && s.arena && s.arena.weather;
        if (!w || typeof w.isDamaging !== 'function' || !w.isDamaging() || typeof self.executeForAll !== 'function') return;
        const weather = WEATHERS[w.weatherType] || String(w.weatherType);
        const safe = new Set();
        for (const p of s.getField(true)) if (p && askYes('weatherDamage', { pokemon: p, weather })) safe.add(p);
        if (!safe.size) return; // nobody is protected: the game's phase runs untouched
        hadOwn = Object.prototype.hasOwnProperty.call(self, 'executeForAll'); prev = self.executeForAll;
        const exec = self.executeForAll; let n = 0;
        shadow = function (fn) {
          n++;
          if (n !== 2 || typeof fn !== 'function') return exec.apply(this, arguments);
          return exec.call(this, function (p) {
            if (safe.has(p)) { seen.weatherSkipped++; return undefined; }
            return fn.apply(this, arguments);
          });
        };
        shadow.calls = () => n;
        self.executeForAll = shadow;
        seen.weatherShadowed++;
      });
      try { return orig.apply(this, arguments); }
      finally {
        if (shadow) {
          seen.weatherPasses.push(shadow.calls()); if (seen.weatherPasses.length > 20) seen.weatherPasses.shift();
          // take our function off again before the asynchronous third pass (only if it is still ours)
          if (Object.prototype.hasOwnProperty.call(self, 'executeForAll') && self.executeForAll === shadow) {
            if (hadOwn) self.executeForAll = prev; else delete self.executeForAll;
          }
        }
      }
    });
  });

  // ---- 3. powder moves: Move.isTypeImmune(user, target) ----
  // The game's own "this move has no effect on this target because of what the target is" (Grass types against
  // powder). Asked for real hits, for the fight menu's effectiveness labels and by the enemy AI: a pure yes/no.
  function hookMove(proto) {
    return X.wrap(proto, 'isTypeImmune', 'f', orig => function (user, target) {
      const immune = X.guard('f powderMove', () => {
        if (!this.hasFlag(POWDER_MOVE) || this.moveTarget === TARGET_USER || !user || !target || user === target || !X.has('powderMove')) return false;
        seen.powderAsked++;
        return askYes('powderMove', { user, target, moveId: this.id, redirect: false });
      }, false);
      if (immune) { seen.powderBlocked++; return true; }
      return orig.apply(this, arguments);
    });
  }

  // ---- 4. Rage Powder: MovePhase.resolveRedirectTarget() ----
  // The game lets Grass types and Overcoat ignore the redirect of a Rage Powder user (and only of Rage Powder:
  // Follow Me and Spotlight keep pulling). For a protected user, answer "yes" to the Overcoat question while the
  // game's method runs; ability redirects (Lightning Rod ...) computed in the same method stay as the game decides.
  X.phaseClass('MovePhase', proto => {
    seen.hooks.redirect = X.wrap(proto, 'resolveRedirectTarget', 'f', orig => function () {
      const u = this.pokemon; let shadow = null, hadOwn = false, prev;
      X.guard('f powderMove redirect', () => {
        if (!u || !this.targets || this.targets.length !== 1 || !X.has('powderMove')) return;
        const puller = u.getOpponents(true).find(o => { const t = o.getTag('CENTER_OF_ATTENTION'); return !!(t && t.powder); });
        if (!puller) return;
        seen.redirectAsked++;
        if (!askYes('powderMove', { user: puller, target: u, moveId: RAGE_POWDER, redirect: true })) return;
        hadOwn = Object.prototype.hasOwnProperty.call(u, 'hasAbility'); prev = u.hasAbility;
        const has = u.hasAbility;
        shadow = function (id) { return id === OVERCOAT ? true : has.apply(this, arguments); };
        u.hasAbility = shadow;
        seen.redirectBlocked++;
      });
      try { return orig.apply(this, arguments); }
      finally {
        if (shadow && Object.prototype.hasOwnProperty.call(u, 'hasAbility') && u.hasAbility === shadow) {
          if (hadOwn) u.hasAbility = prev; else delete u.hasAbility;
        }
      }
    });
  });

  // ---- 5. Effect Spore: EffectSporeAbAttr.canApply({ pokemon: the ability's owner, opponent: the attacker, move, ... }) ----
  // false = the ability does nothing for this hit (the game's own exit for Grass types and Overcoat: no random
  // number is drawn, no ability bar, no message). Only this attribute class is wrapped: Static, Poison Point,
  // Flame Body are other classes.
  function hookSpore(attr) {
    const proto = attr && Object.getPrototypeOf(attr);
    if (!proto || !Object.prototype.hasOwnProperty.call(proto, 'canApply')) return false;
    return X.wrap(proto, 'canApply', 'f', orig => function (params) {
      const blocked = X.guard('f effectSpore', () => {
        // (the game also runs this check when the ability's owner uses a move on itself: nobody was hit, nothing to ask)
        if (!params || !params.opponent || params.opponent === params.pokemon || !X.has('effectSpore')) return false;
        seen.sporeAsked++;
        return askYes('effectSpore', { pokemon: params.opponent, holder: params.pokemon || null });
      }, false);
      if (blocked) { seen.sporeBlocked++; return false; }
      return orig.apply(this, arguments);
    });
  }
  const sporeAttrOf = ab => { const a = ab && typeof ab.getAttrs === 'function' ? ab.getAttrs('EffectSporeAbAttr') : null; return a && a[0] ? a[0] : null; };
  let pokemonProto = null;
  X.pokemonClass(proto => { pokemonProto = proto; });

  // The Arena, Move and ability-attribute classes are not phases: find one object of each when the game has
  // them (a tick is every 200 ms while a mod is on in a co-op room) and wrap its prototype, once.
  let arenaProto = null, moveDone = false, sporeDone = false, sporeTried = false;
  X.onTick(s => {
    if (s.arena) {
      const ap = X.protoWith(s.arena, 'addTag');
      if (ap && ap !== arenaProto) { arenaProto = ap; seen.hooks.arena = hookArena(ap); }
    }
    if (moveDone && sporeDone) return;
    const party = (s.getPlayerParty && s.getPlayerParty()) || [];
    if (!moveDone) {
      for (const p of party) {
        const pm = p && p.getMoveset && p.getMoveset()[0], mv = pm && pm.getMove && pm.getMove();
        const mp = mv && X.protoWith(mv, 'isTypeImmune');
        if (mp) { moveDone = true; seen.hooks.move = hookMove(mp); break; }
      }
    }
    if (!sporeDone && pokemonProto) {
      // Pokemon.getAbility() answers allAbilities[summonData.ability] when that is set: asked on a stand-in
      // object, so no real Pokémon is touched. Tried once; after that, look at who is on the field.
      let attr = null;
      if (!sporeTried) {
        sporeTried = true;
        attr = X.guard('f effect spore lookup', () => sporeAttrOf(pokemonProto.getAbility.call({ summonData: { ability: EFFECT_SPORE } })), null);
        if (!attr) X.log('f: Effect Spore not found through getAbility, waiting for one on the field');
      } else if (s.currentBattle && s.getField) {
        attr = X.guard('f effect spore on field', () => {
          for (const p of s.getField(true)) {
            const a = sporeAttrOf(p.getAbility()) || sporeAttrOf(p.getPassiveAbility && p.getPassiveAbility());
            if (a) return a;
          }
          return null;
        }, null);
      }
      if (attr) { sporeDone = true; seen.hooks.spore = hookSpore(attr); }
    }
  });
});
