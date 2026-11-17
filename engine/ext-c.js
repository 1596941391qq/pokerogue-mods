// Engine extension of team c (气势纽带 #4, 讲究望远镜 #5, 共生孢子 #6, 粉色香草 #7, 褪色魂心 #9, 队友保险 #10,
// 楔石 #12, 双人自行车 #28, 战斗节拍器 #29). Most of what these items need is in the core already (damageCalc,
// beforeDamage, moveSelect, statChange, moveUsed, the 集火 verdict). This file adds the three things it lacks
// (run on rig c: evidence/c.md):
//
//   event  fatalHit   a move hit has just taken a player's Pokémon to 0 HP and nothing of the game's own
//                     (忍耐, 结实, 气势头带) kept it standing. A listener that returns true keeps it at 1 HP.
//   event  fainted    a Pokémon has really fainted (after 复活种子 had its chance; the core's `faint` fires before)
//   B.knowsMove(p, moveId)   is the move in the Pokémon's moveset right now
//
// For mod authors (简体中文, to go into docs/MOD-API.md):
//
//   事件 `fatalHit`：我方一只宝可梦被招式打到 HP 归零的那一下（忍耐、结实、气势头带这些游戏自带的保命效果都没救下它之后）。
//     收到 `target`（被打的）`attacker`（出招的）`damage`（这一下本来要扣的量）`hp`（挨打前的 HP）
//     `rest`（留 1 点 HP 之后多出来的伤害 = damage − (hp − 1)）`then(fn)`（这一击对每个目标都结算完之后再做的事；
//     想再扣谁的血、发消息都放在这里面，不要在处理函数里直接做）。
//     返回 `true` = 让它留下 1 点 HP、不倒下；第一个返回 `true` 的处理函数说了算，后面的不再问。
//     只有招式直接打的才会来：中毒、天气、反伤、mod 自己用 `B.damage` 扣的血都不算。
//   事件 `fainted`：一只宝可梦真的倒下了（带着复活种子被救起来的不算；`faint` 事件在那之前就会来）。收到 `pokemon`。
//   `B.knowsMove(p, moveId)`：这只宝可梦现在会不会这个招式。
CoopModsExt('c', X => {
  const seen = { fatal: 0, kept: 0, fainted: 0, faintedLate: 0, lateThen: 0 }; // counters for the rig (CoopMods.debug.c())
  X.addEvent('fatalHit');
  X.addEvent('fainted');

  // ---- B.knowsMove ----
  X.extendBattle({
    knowsMove: (p, moveId) => X.guard('c knowsMove', () => p.getMoveset().some(m => m && m.moveId === moveId), false),
  });

  // ---- fainted ----
  // FaintPhase.doFaint is where the game itself reacts to a faint (魂心, 自信过度): it runs once per real faint,
  // not when 复活种子 revives and not when the phase finds the Pokémon standing again.
  // The event is sent from inside doFaint, at its pokemon.resetTera() call: after the game has queued
  // "X 倒下了！" and before it queues what follows a faint. That is where the game's own 魂心 raises its stat,
  // and it matters: when the last teammate standing is moved to the middle (ToggleDoublePositionPhase, queued
  // at the end of doFaint) its battler index changes, and a stat phase queued after that would find nobody.
  // Should resetTera ever not be called there, the event is sent when doFaint returns.
  let faintCtx = null; // the doFaint that is running: { pokemon, told }
  const tellFainted = () => {
    const c = faintCtx;
    if (!c || c.told) return;
    c.told = true;
    if (!X.has('fainted')) return;
    seen.fainted++;
    X.emit('fainted', { pokemon: c.pokemon });
  };
  X.phaseClass('FaintPhase', proto => {
    X.wrap(proto, 'doFaint', 'c', orig => function () {
      const outer = faintCtx;
      faintCtx = X.guard('c doFaint', () => { const p = this.getPokemon(); return p ? { pokemon: p, told: false } : null; }, null);
      try { return orig.apply(this, arguments); } finally {
        if (faintCtx && !faintCtx.told) { seen.faintedLate++; X.guard('c fainted (late)', tellFainted); }
        faintCtx = outer;
      }
    });
  });
  X.pokemonClass(proto => {
    X.before(proto, 'resetTera', 'c', self => { if (faintCtx && faintCtx.pokemon === self) tellFainted(); });
  });

  // ---- fatalHit ----
  // A move hit is Pokemon.damageAndUpdate(dmg, { source: attacker, ignoreFaintPhase: true }) -> Pokemon.damage(),
  // which lets 忍耐 / 结实 / 气势头带 answer first and then takes the HP. With ignoreFaintPhase nothing else has
  // happened at that point (the FaintPhase is queued later by the move, only if the target is still at 0 HP),
  // so putting the HP back to 1 there is all it takes to keep the Pokémon standing.
  // What a listener hands to ev.then() runs when the strike is over for ALL its targets (MoveEffectPhase.end),
  // not right after this target's hit. Reason (seen on rig c, evidence/c.md "Check"): 气势纽带 hands the rest of
  // the hit to the holder there; done in the middle of an enemy's spread move it knocked the holder out while
  // the holder was still a target to come, the game then queued its own FaintPhase for that target as well,
  // and the holder fainted twice ("倒下了" twice, every faint reaction twice, two switch prompts).
  let hit = null; // the move hit being carried out on a player's Pokémon right now: { target, source, done, after }
  let pending = [], strikeEnd = false; // then-callbacks waiting for the end of the strike / is MoveEffectPhase.end hooked
  const flush = () => { const list = pending; pending = []; for (const run of list) run(); };
  X.phaseClass('MoveEffectPhase', proto => { strikeEnd = X.before(proto, 'end', 'c', () => { if (pending.length) flush(); }) === true; });
  X.onTick(() => { if (pending.length && X.phaseNow() !== 'MoveEffectPhase') { seen.lateThen++; flush(); } }); // should the phase ever end another way
  X.onSwitch(() => { pending = []; }); // (a mod switched off or on: nothing is carried over)
  X.pokemonClass(proto => {
    X.wrap(proto, 'damageAndUpdate', 'c', orig => function (dmg, opts) {
      const mine = X.guard('c hit start', () => !!(opts && opts.source && dmg > 0 && this.isPlayer() && !this.switchOutStatus && X.has('fatalHit')), false);
      if (!mine) return orig.apply(this, arguments);
      const outer = hit, ctx = hit = { target: this, source: opts.source, done: false, after: null };
      let r;
      try { r = orig.apply(this, arguments); } finally { hit = outer; }
      if (ctx.after) {
        const fns = ctx.after, run = () => { for (const fn of fns) X.guard('c after fatalHit', () => fn(r)); };
        if (strikeEnd && X.phaseNow() === 'MoveEffectPhase') pending.push(run); else run(); // (not inside a strike: a direct call)
      }
      return r;
    });
    // (EnemyPokemon overrides damage and calls this one through super: the context is only ever a player's Pokémon)
    X.wrap(proto, 'damage', 'c', orig => function (dmg, ignoreSegments, preventEndure, ignoreFaintPhase) {
      const ctx = hit;
      if (!ctx || ctx.target !== this || ctx.done) return orig.apply(this, arguments);
      const hp0 = this.hp;
      const r = orig.apply(this, arguments);
      return X.guard('c fatalHit', () => {
        if (!(hp0 > 0 && this.hp <= 0 && ignoreFaintPhase === true && !preventEndure && r > 0)) return r;
        ctx.done = true;
        seen.fatal++;
        const ev = { target: this, attacker: ctx.source, damage: dmg, hp: hp0, rest: Math.max(1, Math.floor(dmg) - (hp0 - 1)), then: fn => { if (typeof fn === 'function') (ctx.after = ctx.after || []).push(fn); } };
        let keep = false;
        for (const [m, fn] of X.listeners('fatalHit')) {
          if (X.guard('mod ' + m.id + ' fatalHit', () => fn(ev) === true, false)) { keep = true; break; }
        }
        if (!keep) return r;
        seen.kept++;
        this.hp = 1;
        return r - 1;
      }, r);
    });
  });

  X.debug('c', () => ({ ...seen }));
});
