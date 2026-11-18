// 进阶（ascension）：《杀戮尖塔》式的累积难度。选 N 级 = 第 1 到第 N 条规则同时生效，最多 10 级。
// 点子、规则表和原始实现：Chess_大概是屑 & 深溟Ming（B 站 https://space.bilibili.com/358023819 ，
// 原始代码在 https://github.com/Chess12333/pokerogue-desktop 的 coop/ascension.js，直接改的电脑版）。
// 这里照工坊接口（版本 3）重写：规则表不变，全部通过接口做，不再碰游戏内部，所以手机版也能用，能随时关掉。
CoopMods.define('ascension', function (api) {
  const B = api.battle;
  const RULES = [
    [1, '迁徙之时', '有时出现不属于本地区的敌人；\n初始选择点数 10 → 8'],
    [2, '资源短缺', '换地区时的回复只回到 60%；\n复活只恢复原来的 60%'],
    [3, '艰苦行动', '金钱获取降低 15%'],
    [4, '弱点击破', '敌人打在你被克制的属性上，\n伤害 +25%'],
    [5, '严格审核', '最多 5 只：开局选不了第 6 只，\n满 5 只时抓到新的要放走一只'],
    [6, '断绝制图', '拿不到「地图」道具，\n切换地区时不能选目的地'],
    [7, '稀缺', '高级和肉鸽品质的奖励更少出现'],
    [8, '训练严苛', '经验获取变为 80%'],
    [9, '墙立于此', '所有首领的血条段数 +1'],
    [10, '联合狩猎', '20 层之后每 5 层出现一个首领'],
  ];
  const lv = () => Math.max(0, Math.min(10, Math.floor(Number(api.runValue()) || 0)));
  const has = n => lv() >= n;

  api.runSetup({
    title: '进阶等级',
    default: 0,
    options: [{ value: 0, label: '关闭（进阶 0）', description: '不开启任何进阶。\n和没开这个 Mod 时完全一样。' }]
      .concat(RULES.map(r => ({ value: r[0], label: r[0] + '  ' + r[1], description: 'A' + r[0] + ' ' + r[1] + '（含前面各级）\n' + r[2] }))),
    badge: v => (v > 0 ? '进阶 ' + v : ''),
    detail: v => RULES.slice(0, v).map(r => 'A' + r[0] + ' ' + r[1]),
  });

  // A1 迁徙之时
  api.on('wildBiome', ev => (has(1) && ev.random() < 0.18 ? true : undefined));
  api.on('starterPoints', ev => (has(1) ? ev.points - 2 : undefined));
  // A2 资源短缺
  api.on('partyHeal', ev => (has(2) ? Math.max(ev.before, Math.floor(ev.maxHp * 0.6)) : undefined));
  api.on('reviveHp', ev => (has(2) ? Math.max(1, Math.floor(ev.amount * 0.6)) : undefined));
  // A3 艰苦行动
  api.on('moneyGain', ev => (has(3) ? Math.max(1, Math.floor(ev.amount * 0.85)) : undefined));
  // A4 弱点击破
  api.on('damageCalc', ev => {
    if (!has(4) || B.isPlayer(ev.attacker) || !B.isPlayer(ev.target)) return;
    if (ev.effectiveness > 1) return ev.damage * 1.25;
  });
  // A5 严格审核
  api.on('partyMax', ev => (has(5) ? Math.min(ev.max, 5) : undefined));
  api.on('starterMax', ev => (has(5) ? Math.min(ev.max, 5) : undefined));
  // A6 断绝制图
  api.on('itemAllowed', ev => (has(6) && ev.id === 'MAP' ? false : undefined));
  // A7 稀缺：每 1024 次里，肉鸽 12 → 6，高级 48 → 30，少掉的都变成超级
  api.on('rewardOdds', ev => (has(7) ? { rogue: 6, ultra: 30, great: ev.great + (ev.ultra - 30) + (ev.rogue - 6) } : undefined));
  // A8 训练严苛
  api.on('expGain', ev => (has(8) ? Math.floor(ev.amount * 0.8) : undefined));
  // A9 墙立于此
  api.on('bossSegments', ev => (has(9) ? ev.segments + 1 : undefined));
  // A10 联合狩猎
  api.on('bossWave', ev => (has(10) && ev.wave >= 20 && ev.wave % 5 === 0 && ev.wave % 10 !== 0 ? true : undefined));
});
