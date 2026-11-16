# Mod 格式和接口（接口版本 1）

一个 mod 就是 `mods/<id>/` 下的一个文件夹，里面两个文件：`mod.json`（说明）和 `mod.js`（代码）。
mod 只通过下面这套接口干活，不直接碰游戏内部的类和方法——游戏更新后内部名字会变，接口不变。

## mod.json

```json
{
  "id": "better-coop-items",
  "name": "更好的联机道具",
  "version": "1.0.0",
  "author": "写代码的人",
  "credits": "点子：B 站 蟹堡星人",
  "description": "一句话说明，显示在游戏里的 mod 列表上。",
  "default": "off",
  "api": 1
}
```

- `id`：3–40 位小写字母、数字、短横线，必须和文件夹同名，定了就不要改（存档按它认道具）。
- `credits`：点子是谁提的。没有可以不写。
- `default`：玩家没动过开关时是开还是关，不写就是关。
- `id`、`name`、`version`、`author`、`description` 必填。

## mod.js

```js
CoopMods.define('my-mod-id', function (api) {
  const B = api.battle;
  const charm = api.item({
    id: 'lucky-charm', name: '幸运符', tier: 'ULTRA', weight: 4, icon: 'lucky_egg',
    description: '显示在奖励界面上的说明，\n可以换行。',
  });
  api.on('turnEnd', () => {
    for (const p of B.playerField()) if (charm.heldBy(p)) B.message(B.name(p) + '的幸运符在发光！');
  });
});
```

规则：不联网、不读写游戏存档和 localStorage、不改 `window` 上别人的东西；给玩家看的字全部用简体中文。
接口传给你的「宝可梦」是游戏自己的对象，只把它原样传回 `api.battle` 的函数，不要读写它身上的字段。

## 道具 `api.item(def)`

| 字段 | 说明 |
|---|---|
| `id` | 小写字母、数字、短横线。存档里记的是 `mod id:道具 id` |
| `name` `description` | 名字和说明（中文） |
| `tier` | 品质：`ULTRA` 金、`ROGUE` 红、`MASTER` 紫（也可以 `COMMON` 白、`GREAT` 蓝） |
| `weight` | 在同品质奖励里的权重，和原版道具一个量级。上限：白 4、蓝 4、金 9、红 5、紫 14，超过按上限算，保证不比同品质的原版携带道具更常见 |
| `icon` | 游戏道具图集里的图名（例如 `choice_specs`）。暂时不能带自己的图，先借一张像的，在说明里写明是占位 |

道具只在双人合作的战后「5 选 2」奖励里出现，选中后给自己的一只宝可梦带上。它不是游戏原生道具：谁带着什么由 mod 层自己记，写在存档的一个附加块里，关掉 mod 或换成没有 mod 的版本读档都不会出错。

返回的对象：

- `item.heldBy(p)`：这只宝可梦带着它吗（mod 关着时永远是否）
- `item.state(p)`：这件道具的小本子，一个普通对象，会跟着存档走，只放数字、字符串、布尔值
- `item.give(p, state)` / `item.remove(p)`：给上、拿走（消耗品用完就 `remove`）
- `item.key`、`item.name`

## 事件 `api.on(名字, 处理函数)`

| 事件 | 什么时候 | 收到什么 | 返回值 |
|---|---|---|---|
| `damageCalc` | 算一次招式伤害时（真打和 AI 估算都会来） | `attacker` `target` `damage` `critical` `simulated`（估算时为真，这时不要发消息、不要改状态） | 返回数字 = 新的伤害 |
| `beforeDamage` | 任何一次扣血之前 | `target` `damage` `source` `byMove`（是招式打的）`lethal`（会打倒）`fullHp`（满血）`then(fn)`（扣完血后再做的事） | 返回数字 = 实际扣多少 |
| `moveSelect` | 玩家选招、游戏判断某招能不能选时 | `pokemon` `moveId` | 返回一句话 = 不能选，并显示这句话 |
| `status` | 陷入异常状态后 | `pokemon` `status`（`poison` `toxic` `paralysis` `sleep` `freeze` `burn`） | — |
| `statChange` | 能力等级真的变了之后 | `pokemon` `changes`（`[{stat, stages}]`，实际生效的量）`copied`（是 `B.changeStats` 造成的） | — |
| `faint` | 一只宝可梦倒下 | `pokemon` | — |
| `turnStart` / `turnEnd` | 回合开始出招前 / 回合结束 | — | — |
| `give` / `remove` | 一件 mod 道具被带上 / 拿走 | `pokemon` `item`（道具的 key） | — |

还有一个更底层的：`api.onPhase('TurnInitPhase', fn, 'start' | 'end')`，在游戏的某个阶段开始前或结束时调用。阶段名是游戏内部的类名，官方更新可能改名，能用上面的事件就不要用它。

处理函数里出错不会让游戏崩：错误记进日志，这次调用当作没发生。

## 战场 `api.battle`

- 看：`name(p)` `isPlayer(p)` `index(p)`（0、1 我方，2、3 对面）`owner(p)`（`'p1'` / `'p2'`）`hp(p)` `maxHp(p)` `onField(p)` `playerField()` `ally(p)`（场上的队友，没有就是 null）`status(p)` `statusName(状态)` `wave()` `turn()`
- 招式：`moveName(p, moveId)` `moveCount(p)`（上场以来用过几次招）`firstMoveSince(p, n)`（从第 n 次起用的第一个招式）
- 集火：`focusTarget()`——这回合两位玩家用单体招式瞄准的同一个敌人的位置，没有集火就是 null。和游戏里「集火」横幅用的是同一个判定
- 做：`message(文字)` `damage(p, 数值)`（直接扣血，不算招式）`cureStatus(p)` `changeStats(p, changes)`（照样改能力等级，并打上 `copied` 标记防止来回传）

另外：`api.fieldState(p, 名字)` 是只在这只宝可梦留在场上期间有效的小本子（换下就清，不进存档）；`api.log(...)` 写日志；`api.manifest` 是自己的 mod.json。

## 提交前自查

```
node tools/build-mods.mjs . --check
```

会检查每个 mod 的 mod.json 字段、id 和文件夹名是否一致、mod.js 有没有语法错误。

## 现在还做不到的

- 自带图标、自带音效
- 单人模式里生效（目前所有 mod 只在双人合作房间里运行）
- 道具在宝可梦之间转移、被对手夺走
- 新招式、新特性、新宝可梦、改界面

想要的能力不在上面，就提个 issue 说你要做什么，接口会按真实需求加。
