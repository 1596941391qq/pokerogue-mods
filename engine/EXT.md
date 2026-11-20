# Engine extensions (engine/ext-<team>.js)

The mod engine is `engine/host-mods.core.js` (接口版本 3). It owns the tables (mods, items, who holds what, the
team bag), the save block, the icons, the plates and the list of mods, and the hooks every mod needs (phase
starts and ends, damage, move choice, status, stat stages, heal, the reward screen).

Everything else a v0.9 item needs from the game goes into **one file per team**: `engine/ext-<team>.js`
(`ext-b1.js`, `ext-b2.js`, `ext-c.js`, `ext-d.js`, `ext-e.js`, `ext-f.js`, since 接口版本 3 `ext-g.js`, and `ext-h.js`, written by chenjunjue / xiaochen2245 for the mod trainer-growth: data outside a run, the growth panel, the caught / egg gacha / permanent stat events). Nobody edits the core, and nobody
edits another team's file. `tools/assemble.mjs` writes `host-mods.js` = the core followed by the extensions in
file-name order.

```js
// engine/ext-d.js
CoopModsExt('d', X => {
  // runs once, right after the core, BEFORE any mod is defined and usually before the game has a scene
  ...
});
```

- The name is your team's. A second `CoopModsExt` with a name already seen is ignored (the scripts are
  injected twice: from the menu, then with the room).
- **An extension that throws while installing is logged and skipped**
  (`COOP mods extension d failed to install, skipped: <stack>`); the core, the other extensions and the mods
  go on without it. What it did before the throw stays (an event it added, a tick it registered), so do the
  risky part first. `CoopMods.extensions()` gives `{ d: 'ok', e: '<the error>' }`.
- At install time there is normally **no scene, no party, no phase yet**. Do not touch the game there: register
  what you want (`X.onTick`, `X.phaseClass`, `X.pokemonClass`, `X.onRewardOptions`) and do the work when called.
- Logs: English, through `X.log(...)` (they come out as `COOP mods ...` in `rigs/<name>/host.log`).
  Player-facing text: 简体中文.

## The three rules

1. **Wrap and pass through.** Hook the game only with `X.wrap` / `X.before` / `X.after`. They replace a method
   once, and while no mod is switched on, or outside a co-op room, the game's own method is called directly, as
   if nothing were there. Inside your hook, first check that there is something to do (an item is held:
   `X.count(p, key) > 0`), and otherwise call the original with the arguments unchanged.
2. **An error must never stop the game.** `X.before` and `X.after` catch what your function throws (logged, at
   most 20 times per hook, then the original result is used). In an `X.wrap` replacement you write yourself,
   put your own part in `X.guard('what', () => { ... }, fallback)` and always reach the original.
   (The game catches errors inside a move's execution itself and then cancels the move: an uncaught error in
   a damage hook would silently eat moves.)
3. **Only the engine knows the game.** A mod fragment (`mod/items/<team>.js`) never sees a game class. Your
   extension turns the game into something a mod can use: an event (`X.addEvent` + `X.emit`), a battle helper
   (`X.extendBattle`) or an `api` function (`X.extendApi`). Keep those small, and describe each one for mod authors (简体中文, in the style of docs/MOD-API.md).
   docs/MOD-API.md is one file shared by all teams: unless your instructions say otherwise, write your part
   as `docs/api-<team>.md` so that six teams do not edit the same file at once, and say so in your report.

## What X is

### Basics

| | |
|---|---|
| `X.version` | `2` (接口版本) |
| `X.scene()` | the BattleScene (`window.PRS_SCENE`), may be undefined while the game boots |
| `X.log(...)` | `COOP mods ...` in the console and host.log; strings as they are, anything else as JSON |
| `X.uiMode()` | what is on screen: `'COMMAND'`, `'FIGHT'`, `'TARGET_SELECT'`, `'PARTY'`, `'MODIFIER_SELECT'`, `'MESSAGE'` ... or null |
| `X.active()` | a co-op room is open and the game has its phase manager |
| `X.isOn(modId)` / `X.anyOn()` | is this mod / any mod switched on |
| `X.itemOn(key)` | the item exists and its mod is on |
| `X.phaseNow()` | class name of the current phase, or null |
| `X.inBattle()` | same as `B.inBattle()`: between the start of an encounter and the end of its battle |
| `X.turnKey()` | `'<wave>:<turn>'`, `''` without a battle |
| `X.nameOf(p)` | the Pokémon's name as the game shows it |
| `X.battle` | the `api.battle` object the mods get (`B`): use its helpers instead of re-reading the game |
| `X.STAT` | the same as `api.STAT`: `atk 1, def 2, spatk 3, spdef 4, spd 5, acc 6, eva 7`, `.names`, `.battle` (the five), `.name(x)`, `.zh(x)`, `.num(x)` |
| `X.guard(what, fn, fallback)` | run `fn()`; an error is logged under `what` and `fallback` is returned |

### The tables (read, do not write)

| | |
|---|---|
| `X.items` | `{ 'modId:itemId': def }`, def = `{ key, mod, id, name, description, tier ('ULTRA'...), weight, kind ('held' / 'passive'), max, v1, icon, custom, fallback }`. Filled when the mods are defined, i.e. AFTER your install function ran: read it when called, not at install. |
| `X.mods` / `X.order` | `{ modId: { id, manifest, items: [keys], ok, error, v1, ... } }` / mod ids in load order |
| `X.TIER` | `{ COMMON: 0, GREAT: 1, ULTRA: 2, ROGUE: 3, MASTER: 4 }` (the game's ModifierTier numbers) |
| `X.tierName(t)` | `'普通道具' '超级道具' '高级道具' '肉鸽道具' '大师道具'` for a name or a number |
| `X.tierColor(t)` | the rarity's colour as CSS (`'#f5c84c'` ...) |
| `X.kindName(k)` | `'携带道具'` / `'被动增益'` |
| `X.key(modId, itemId)` | `'modId:itemId'` (item keys look like `'better-coop-items:pink-herb'`) |
| `X.cfg` | `{ normalOffer: true, screenChance: 0.1 }`, see "Rewards" |

### Who has what

`p` is a Pokémon of the party; pass `null` for a passive item (it lives in the team bag).

| | |
|---|---|
| `X.give(p, key, state?, from?)` | one more. Held: up to `max` on that Pokémon; passive: up to `max` in the bag. `false` when it is full (or the key is unknown). Emits `give { pokemon, item, count, from }`; `from` is `'reward'` when picked on the reward screen, else what you pass (default `'mod'`). `state` is only used for the first one. |
| `X.take(p, key, n = 1)` | `n` fewer; the last one takes the state with it. Emits `remove { pokemon, item, left }`. `false` when there was none. |
| `X.remove(p, key)` | all of them |
| `X.count(p, key)` | how many (0 while the item's mod is off) |
| `X.state(p, key)` | the item's state object (one per holder, one per team for a passive item), saved with the run: JSON values only. `null` when not held. |
| `X.holders(key)` | the party's Pokémon that hold it, in party order |
| `X.heldItems(p)` / `X.bagItems()` | `[{ key, def, state, count }]`, items of mods that are on |
| `X.canTake(key, who?)` | is there room for one more: any Pokémon of the party below its max (with `who` = `'p1'` / `'p2'` only that player's own), or the bag below `max` |
| `X.onMax(fn(p, key, max))` | a held item's max on one Pokémon: `fn` returns the new max (a number; anything else leaves it). Asked wherever the core compares a count with the max (`give`, `canTake`, the reward pick and its `已经带满了（最多N个）` text) while the item's mod is on. Functions are asked in the order they were registered, each sees the number the one before left; the result is kept between 1 and 999. Passive items always use the table's `max`. Lowering a max does not take anything away: do that yourself (`X.take`). ext-e.js uses it for 异次元树果袋 (`api.countsAsBerry`). |
| `X.maxOf(p, key)` | the max that holds for this Pokémon right now (the item's `max` after every `X.onMax` function) |

Held items are stored by `pokemon.id`. Only Pokémon in the party are written to the save.

### Events (engine -> mods)

| | |
|---|---|
| `X.addEvent(name)` | make `api.on(name, fn)` legal for mods. Name: a letter, then letters / digits, 3-40 long (`'berryEaten'`). Call it at install time, the mods are defined right after. |
| `X.has(name)` | is anybody listening (a mod that is on, in a co-op room). Check it before doing any work to build the event. |
| `X.emit(name, ev)` | call every listener, in mod order; a listener's error is logged against its mod. Returns the last value a listener returned that was not `undefined` (use it for "may a mod change this number / say no"). |
| `X.listeners(name)` | `[[mod, fn], ...]` when you need every answer yourself |

The core's own events (all described for mod authors in docs/MOD-API.md): `damageCalc`, `beforeDamage`,
`moveSelect`, `status`, `statChange`, `faint`, `turnStart`, `turnEnd`, `give`, `remove`, and new in 接口版本 2
`heal`, `moveUsed`, `battleStart`, `battleEnd`. Facts worth knowing here:

- `damageCalc`: a listener returns the new damage; the numbers are **not floored between listeners**, only
  once after the last one (`max(1, floor)`), so several multipliers combine exactly. False Swipe and Sturdy
  (a hit the game limited to leave 1 HP) keep their limit.
- `faint` fires when a FaintPhase starts for a Pokémon at 0 HP. That is before the game looks at 复活种子:
  a Pokémon that is revived by it has still "fainted" for this event. If your item needs "really gone", make
  your own event in your extension.
- `turnStart` fires at the start of TurnStartPhase, when every command is in. `B.focusTarget()` and
  `B.focusStreak()` are right from that moment on (the engine reads the rule itself there and counts on from
  host-game.js's streak; it does not wait for host-game.js's 120 ms poll).
- `heal` fires for every gain of HP that goes through `Pokemon.heal` (heal phases, abilities, berries):
  `{ pokemon, amount (really restored), tag, inBattle, phase }`. Medicine used on the reward screen or in the
  shop does NOT cause it (the game's medicine writes `pokemon.hp` itself): ext-d.js has `medicineUsed` for that.
- `moveUsed` fires at MoveEndPhase: `{ pokemon, moveId, targets, ok, damage, hits: [{ target, damage }], followUp }`.
  The user is the Pokémon the MovePhase was for, also when it has left the field by then (knocked out by its
  own recoil: the slot's battler index may already name its replacement). It then has no move history:
  `moveId` is the MovePhase's move, `ok` is "it hit somebody", `targets` the battler indexes it hit. A handler
  that acts on the user checks `B.onField(p)` first.
- `battleStart` fires at the first TurnInitPhase of a wave the engine has not seen in this visit to the run:
  a new wave, a run entered from the title (also the same wave continued from its save in one session).
- `faint` (core) is the start of FaintPhase, before 复活种子; `fainted` (ext-c.js) is inside `doFaint`, when the
  Pokémon is really gone. A stat change for the teammate belongs in `fainted`: queued after `doFaint` has
  returned it can be lost (the survivor's battler index changes).
- Damage handed to another Pokémon in the middle of a strike (`B.damage` from a `beforeDamage` / `damageCalc`
  handler or its `then`) can make that Pokémon faint twice when it is a later target of the same strike. Do it
  when the strike is over: `fatalHit`'s `then` (ext-c.js runs it at `MoveEffectPhase.end`) or `moveUsed`.

### Giving mods more to work with

| | |
|---|---|
| `X.extendBattle({ name: fn, ... })` | add helpers to `api.battle` (all mods, all fragments). Throws when a name exists already, so nobody overwrites the core or another team by accident: pick clear names. |
| `X.extendApi((mod, api) => ({ name: fn, ... }))` | add functions to each mod's `api` object (called once per mod while it is being defined; `mod.id` tells you which). A name that is taken is left out and logged. |

### Being called

| | |
|---|---|
| `X.onTick(fn(scene))` | every 200 ms while a co-op room is open and a mod is on. Errors are caught. Keep it cheap. |
| `X.onSwitch(fn(modId, on))` | a mod was switched on or off in the list. When the last mod goes off every wrap passes straight through from that moment (also in the middle of a screen or a turn): whatever you changed outside a wrap (a field on a game object, a queued phase, a price label on screen, stacks above the game's cap) you put back here. |
| `X.phaseClass(name, fn(proto, phase))` | once, with the prototype of that phase class, the first time a phase of that class is about to start (`phase` is that instance), or right away if one already has (`phase` is then null). This is where you wrap a phase's methods: nothing but `start` has been called on it yet. Also called again if the game ever swaps the class's prototype. The phase that is running at the moment the hooks go in (a mod switched on in the middle of a reward screen) is handed in the same way, so its class is wrapped at once and not only from the next phase of that class on. |
| `X.pokemonClass(fn(proto))` | once, with the game's `Pokemon` prototype (the one that owns `damageAndUpdate`, `heal`, `getAttackDamage`, `getStat` ...; PlayerPokemon and EnemyPokemon inherit from it), as soon as there is a party in a co-op room with a mod on |
| `X.onRewardOptions(fn(phase, options))` | for every list of reward options the game makes (`SelectModifierPhase.getModifierTypeOptions`) while a mod is on, after the core's own offer. Change the array in place or return a new one. |

For anything else (a UI handler, the scene, a modifier class) find the object yourself in a tick or in one of
these callbacks and wrap it there. `X.protoWith(obj, 'method')` gives the prototype in `obj`'s chain that
defines `method` itself.

### Hooks

| | |
|---|---|
| `X.wrap(obj, method, tag, make)` | `obj[method] = make(original)`, once per (obj, method, tag): a second call with the same tag does nothing and returns true. `make` gets the game's method and returns the replacement (a `function`, so `this` works). While no mod is on, or outside a co-op room, callers reach the original directly. Returns false (and logs) when there is no such method. |
| `X.before(obj, method, tag, fn(self, args))` | `fn` runs before the original. Return `{ args: [...] }` to call it with other arguments, `{ skip: true, value }` to not call it at all, anything else to leave it alone. |
| `X.after(obj, method, tag, fn(self, args, result))` | `fn` runs after the original. Return `{ value }` to change what the caller gets, anything else keeps `result`. |

`tag` is your team name (or team name + a word): it is what makes the wrap happen once, and it shows in the
logs. `wrap`, `before` and `after` with the same tag on the same method are three separate hooks. The marker
is kept on the object itself (`__coopModsWraps`, not enumerable), so a prototype the game builds anew gets
wrapped again.

Where your wrap sits next to the core's own:
- Phase methods wrapped inside `X.phaseClass` (registered at install time) are wrapped BEFORE the core wraps
  that class, so yours is the inner one. This matters for the four phase methods the core wraps itself:
  `SelectModifierPhase.getModifierTypeOptions` (your wrap sees the game's list before the core's offer; use
  `X.onRewardOptions` to see it after), `SelectModifierPhase.applyChosenModifier` (a pick of a mod item made by
  `X.makeOption` is handled by the core and never reaches your wrap), `StatStageChangePhase.applyStatChangesAndEnd`
  and `PokemonHealPhase.doHealPokemon`.
- Pokémon methods wrapped inside `X.pokemonClass` are wrapped AFTER the core's five (`getAttackDamage`,
  `damageAndUpdate`, `isMoveSelectable`, `doSetStatus`, `heal`), so yours is the outer one: your `before` sees
  the call before the mods' `damageCalc` / `beforeDamage` handlers, your `after` sees the result they left.
- Two extensions wrapping the same method both stay (file-name order, the later one outside).
- `X.gameMethod(obj, name)` is `obj[name]` as it was before the core or any extension wrapped it on that
  object (or `obj[name]` itself when nobody has). Use it when you must run the game's own method whatever the
  install order, e.g. to roll the game's reward list without the other extensions' changes (ext-b1.js does,
  for `SelectModifierPhase.getModifierTypeOptions` and `start`). It does not see through a wrap that somebody
  put on with plain assignment instead of `X.wrap` / `X.before` / `X.after`.

What the six extensions of v0.9 wrap, so the next one knows its neighbours (all run together on rig int,
evidence/integration.md):

| method | who (inner -> outer) | note |
|---|---|---|
| `SelectModifierPhase.getRerollCost` | b1, b2 | b1 answers -1 / the game's price for its own screens; b2 (肉鸽骰子) sees that price and makes it 0 while free rerolls are left, on b1's screens too |
| `SelectModifierPhase.getModifierTypeOptions` | (host-team.js) b2, core | b1 rolls with `X.gameMethod`, so its own lists never pass b2's wrap |
| `SelectModifierPhase.getModifierCount` | (host-team.js) b2 | b2 leaves set lists alone: b1's screens keep 4 / 6 / 3 |
| `SelectModifierPhase.start` | b1, b2 | b1 prepares (or skips) its own screens; b2 only counts rerolls |
| `SelectModifierPhase.resetModifierSelect` (b1), `rerollModifiers` (b2), `AttemptCapturePhase` (b2) | one each | |
| `ModifierSelectUiHandler.processInput` | b1 | 确认 / 取消 wait for the balls on every reward screen while a mod is on |
| `Pokemon.damageAndUpdate`, `Pokemon.damage` | core, c, d | d is outermost: `hpLost` reports what was really lost after c kept somebody at 1 HP |
| `PokemonHealPhase.doHealPokemon` | d, core | |
| `MoveEffectPhase.end`, `FaintPhase.doFaint`, `Pokemon.resetTera` | c | |
| `BerryPhase.eatBerries`, `BerryModifier.getMaxHeldItemCount`, `Pokemon.recordEatenBerry`, `tryTransferHeldItemModifier`, the save's `getSessionSaveData` / `parseSessionData` | e | the core hooks the same two save methods (on the instance, earlier); both stay |
| `WeatherEffectPhase.start`, `MovePhase.resolveRedirectTarget`, `Arena.addTag`, `Pokemon.isTypeImmune`, the 孢子 ability's `canApply` | f | |

"A mod is on" is checked per call. It does **not** check that your item is held: do that yourself, first thing.

### Rewards

The core already does this on the reward screen:

- **Offer.** On the normal 5 选 2 screen (first round, tagged by host-team.js as `phase.__coop = { round: 1, picker }`),
  a slot may be replaced by a mod item of the same rarity (weight against the pool), and about one screen in
  ten swaps one slot for a mod item (`X.cfg.screenChance`). An item nobody can take any more (`X.canTake(key, picker)`
  false) is never offered. `X.cfg.normalOffer = false` switches both off, for an extension that offers mod
  items its own way (team b1, issue #2). The switch is global on purpose: one mod with an `exclusive` reward
  screen takes the items of every mod out of the normal reward (they are all offered on that screen instead).
  `CoopMods.debug.forceReward` still puts its keys on the next normal screen while the switch is off, and
  nothing else.
- **Pick.** `applyChosenModifier` of an option made by `X.makeOption` never reaches the game: a passive item goes
  into the bag (`from: 'reward'`), a held item opens the party menu (host-team.js limits it to the picker's
  own Pokémon) and a Pokémon at `max` is refused with `<名字>的<道具>已经带满了（最多N个）`. Then the round ends
  like any other pick (`phase.applyModifier`).

| | |
|---|---|
| `X.makeOption(like, key, upgradeCount = 0)` | a reward option (the game's `ModifierTypeOption` class) for a mod item: name, description, icon, tier colour, cost 0. `like` is any option the game made (its class is taken); pass `null` once the game has shown a reward screen in this session. `null` for an unknown key. The option's `type.__coopMod` is the item key. |
| `X.rng(string)` | a small seeded generator: `const next = X.rng(seed + ':' + wave + ':mine'); next()` gives numbers in [0, 1), always the same for the same string. Use it for anything that must come out the same after a reload. |
| `X.random(tag)` | `B.random(tag)`: one number in [0, 1), the same for the same run, wave, turn and tag |
| `X.frameOf(key)` | the frame of the game's `'items'` texture that shows this item right now (the mod's own icon once decoded, else its fallback) |
| `X.redraw()` | draw the plates again at the next tick (after you changed something they show) |

Note from host-team.js: `phase.__coop` is the boolean `true` (inherited from the prototype) on a reward phase
it did not tag; test `typeof phase.__coop === 'object'` before reading `.round` / `.picker`.

### Testing

| | |
|---|---|
| `X.debug(name, fn)` | adds `CoopMods.debug.<name>` for your tests (throws when the name exists). Not for mods, not for the game. |

Already there: `CoopMods.debug.hooked()`, `.held()`, `.bag()`, `.block()` (what the next save carries),
`.give(partyIndex, key, state?)`, `.take(partyIndex, key, n = 1)`, `.remove(partyIndex, key)`,
`.forceReward([keys])` (the next reward screen offers them, one per slot), `.chance()`, `.icons()`,
`.events()`, `.battle` (the `B` object). And `CoopMods.extensions()`, `CoopMods.list()`,
`CoopMods.setOn(modId, true)`, `CoopMods.heldNames(p)`, `CoopMods.bagNames()`, `CoopMods.openPanel()`.
From the extensions: `CoopMods.debug.b1Force([screen ids])`, `.b1Wave(n)`, `.b1Options(id, wave, n, reroll, round)`,
`.b1State()`, `.b2()`, `.c()`, `.eCaps()`, `.eBerries(partyIndex)` (see the end of each `engine/ext-*.js`).

## A worked example

Item: "when the holder is healed in battle by anything but this item, its teammate is healed for half as
much". The core has the `heal` event and `B.heal`, so the mod could do this alone; the example adds one thing
the core does not have, so that every part shows: the game's 回复护符 multiplier, offered to mods as
`B.healBoost()`, and an event `overheal` for heals that hit a Pokémon already at full HP (which `heal` never
reports, because nothing was restored).

```js
// engine/ext-d.js
CoopModsExt('d', X => {
  const B = X.battle;
  X.addEvent('overheal');                                   // mods may now api.on('overheal', fn)

  // a helper for mods: how much the team's 回复护符 multiply healing (1 when there are none)
  X.extendBattle({
    healBoost: () => X.guard('d healBoost', () => {
      const h = { value: 1 };
      X.scene().modifiers.filter(m => m.constructor.name === 'HealingBoosterModifier').forEach(m => m.apply(h));
      return h.value;
    }, 1),
  });

  // the hook: PokemonHealPhase.doHealPokemon is where a heal phase really restores HP
  X.phaseClass('PokemonHealPhase', proto => {
    X.before(proto, 'doHealPokemon', 'd', self => {
      if (!X.has('overheal')) return;                        // nobody listens: nothing to do
      const p = self.getPokemon();
      if (p && p.isFullHp()) X.emit('overheal', { pokemon: p, amount: self.hpHealed });
      // returning nothing: the game's method runs as it was called
    });
  });

  X.debug('dHealBoost', () => B.healBoost());                // CoopMods.debug.dHealBoost() from the rig
});
```

```js
// mod/items/d.js (a fragment: the body of function (api, B, shared))
const rope = api.item({
  id: 'life-red-string', name: '生命红绳', tier: 'ULTRA', kind: 'held', max: 2, weight: 4,
  description: '携带者在战斗中回复HP时，\n队友也回复其中一半。',
});
api.on('heal', ev => {
  if (!ev.inBattle || ev.tag === 'red-string') return;       // not our own heal coming back
  const n = rope.count(ev.pokemon), mate = B.ally(ev.pokemon);
  if (!n || !mate) return;
  B.heal(mate, Math.floor(ev.amount * 0.5 * n), { tag: 'red-string', message: B.name(mate) + '通过生命红绳回复了HP！' });
});
api.on('overheal', ev => { api.log('wasted heal on', B.name(ev.pokemon), ev.amount); });
```

What happens with the mod off: `X.before` never runs `fn` (the wrapper calls the original directly),
`X.has('overheal')` is false, `rope.count` is 0. With the extension broken: the mod fails to load with
`unknown event overheal` (the event was never added), which is what you want to see in a test, and the game
runs on without the mod.

(The numbers and the wording of the real 生命红绳 are team d's to decide from the issue; this is only the shape.)

## 接口版本 3: solo games, values per run, `ext-g.js`

Asked for by B 站 Chess_大概是屑 & 深溟Ming for their 进阶 (ascension) mod. What changed for extension writers:

- **The engine now loads with every page**, not only with a co-op room (desktop: `main.mjs` injects
  `host-mods.js` and `mods-bundle.js` on every load; mobile: two `<script defer>` tags from `patch-web.mjs`).
  While there is no co-op room and no switched-on mod that lists `"solo"` in `modes`, the timer returns at once
  and nothing of the game is wrapped.
- `X.coop()` is true inside a co-op room. `X.wanted(id)` is the player's switch; `X.isOn(id)` is the switch AND
  the mod's `modes` fitting the game being played. Use `isOn` to decide whether a mod acts, `wanted` to draw
  the switch.
- `X.runState(id)` is the mod's plain object of this run (what `api.runState()` returns). It is written into
  the save block as `run: { <modId>: {...} }`. While a new game's starter screen is up there is no run yet:
  writes go into a holding object that becomes the run's when the first wave begins. `X.inSetup()` tells you
  are there; `X.onSetup(fn)` calls you when that screen opens.
- `X.onPanel((id, render) => element | null)` adds a block under a mod in the list of mods (`X.el` builds
  elements); call `render()` after changing something. `X.panelOpen()`.
- `damageCalc` events carry `moveId` and a lazy `effectiveness`.

`ext-g.js` uses these for the difficulty events (`partyMax`, `starterMax`, `starterPoints`, `rewardOdds`,
`moneyGain`, `expGain`, `partyHeal`, `reviveHp`, `bossWave`, `bossSegments`, `wildBiome`, `itemAllowed`) and for
`api.runSetup`; its header comment lists each event with what it carries. Four of them cannot be done by wrapping
and need the game build patched (the same list in the desktop repo's `scripts/patch-coop.mjs` and the mobile
repo's `scripts/patch-web.mjs`): the game asks `window.PRS_PARTY_MAX()`, `window.PRS_STARTER_MAX()`,
`window.PRS_POINTS()` and `window.PRS_T(index)`, which `ext-g.js` defines. Without the engine loaded the
patched game falls back to its own numbers.

Testing a solo mod: `RIG_SOLO=1 rigs/rig.sh start solo <absolute path of public>` starts the game with only
`host-mods.js` and `mods-bundle.js` injected (no room); `CoopMods.debug.g()` shows how often each event was
asked, the last before/after values, the limits in force and every mod's run choice.
