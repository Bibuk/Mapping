/*
 * simulation.js — «скрытая экономика» и развитие населённых пунктов во времени.
 *
 * Карта рождается поэтапно: сначала генератор делает ЛАНДШАФТ и расставляет
 * точки РЕСУРСОВ, затем небольшие посёлки-зачатки развиваются тик за тиком
 * (условный «год»):
 *   - растут за счёт удобного места, доступа к ресурсам и торговли;
 *   - тянут дороги к ближайшим ценным ресурсам и осваивают их (дорога → шахта);
 *   - соединяются дорогами между собой и через эту сеть ТОРГУЮТ (делятся
 *     доступом к ресурсам — это и есть «скрытая экономика»);
 *   - при доступе к руде+углю или нефти ИНДУСТРИАЛИЗИРУЮТСЯ;
 *   - «вид» пункта (деревня…мегаполис) НЕ задан заранее, а ВЫРАСТАЕТ из
 *     населения — кто удачно встал и развил экономику, тот и стал городом.
 *
 * Всё детерминировано (свой ГПСЧ от сида). На каждый тик сохраняется снимок
 * (население/вид/индустрия каждого пункта), а дороги и шахты помнят, на каком
 * тике появились, — поэтому renderer умеет показать ЛЮБОЙ момент истории, и
 * развитие можно проиграть как анимацию.
 */

// Пороги населения для «вида» пункта (деревня…мегаполис). Откалиброваны под
// диапазон населения, который даёт симуляция за ~70 «лет».
const TIER_POP = [0, 1200, 4000, 12000, 40000];

class WorldSim {
  /*
   * gen   — генератор (нужен его поиск пути A* и поля рельефа);
   * opts  — { resources, seeds, cost, height, ticks }
   */
  constructor(gen, opts) {
    this.gen = gen;
    this.size = gen.size;
    this.cellKm = gen.cellKm;
    this.cost = opts.cost;
    this.height = opts.height;
    this.ticks = opts.ticks || 64;
    this.resources = opts.resources;

    // Свой генератор случайных чисел — независимый и воспроизводимый.
    this._s = (gen.seed ^ 0x9e3779b9) >>> 0;

    // Население-зачатки. Лучшие по пригодности места «основываются» раньше —
    // так пункты появляются на карте постепенно.
    const seeds = opts.seeds.slice().sort((a, b) => b.suit - a.suit);
    this.settlements = seeds.map((s, i) => ({
      id: i,
      x: s.x,
      y: s.y,
      suit: s.suit,
      pop: 250 + this._rand() * 350,
      tier: 0,
      industry: 0,
      owned: new Set(),       // id освоенных ресурсов
      project: null,          // текущая стройка { resId, mineProgress }
      links: new Set(),       // id соединённых дорогой пунктов
      foundTick: Math.floor((i / Math.max(1, seeds.length)) * this.ticks * 0.35),
    }));

    this.roads = [];          // { from, to|resId, path, klass, kind, builtTick }
    this.history = [];        // history[t] = [{pop,tier,industry,alive}]
    this._stride = Math.max(2, Math.round(this.size / 120));
  }

  _rand() {
    this._s = (this._s + 0x6d2b79f5) | 0;
    let t = Math.imul(this._s ^ (this._s >>> 15), 1 | this._s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /* Запускает симуляцию на все тики и возвращает результат. */
  run() {
    for (let t = 0; t < this.ticks; t++) {
      this._tick(t);
      this.history.push(
        this.settlements.map((s) => ({
          pop: s.pop,
          tier: s.tier,
          industry: s.industry,
          alive: s.foundTick <= t,
        })),
      );
    }
    // Финализируем класс дорог по итоговым видам пунктов.
    for (const r of this.roads) {
      if (r.kind === "trade") {
        r.klass = this.gen._roadClass(this.settlements[r.from], this.settlements[r.to]);
      } else {
        r.klass = "local"; // подъездные к шахтам — местные
      }
    }
    return { settlements: this.settlements, roads: this.roads, resources: this.resources, ticks: this.ticks, history: this.history };
  }

  /* Один тик развития. */
  _tick(t) {
    const alive = this.settlements.filter((s) => s.foundTick <= t);

    // 1) Доступ к ресурсам с учётом торговли: пункты, соединённые в одну сеть
    //    дорог, делят доступ к ресурсам друг друга (скрытая экономика).
    const access = this._tradeAccess(alive);

    // 2) Рост населения, индустриализация, смена «вида».
    for (const s of alive) {
      const compKeys = access.get(s.id); // ресурсы всей торговой сети
      const ownedKeys = new Set();
      for (const id of s.owned) ownedKeys.add(this.resources[id].type);

      let g = 0.015 + s.suit * 0.025; // база + удобство места

      // Ресурсы: СВОЯ шахта даёт полный бонус, привозной по торговле — лишь
      // малую долю. Поэтому богатеют прежде всего владельцы ресурсов.
      let hasIron = false, hasCoal = false, hasOil = false;
      for (const key of compKeys) {
        const rt = RESOURCE_BY_KEY[key];
        if (rt) g += rt.growth * (ownedKeys.has(key) ? 0.055 : 0.012);
        if (key === "iron") hasIron = true;
        if (key === "coal") hasCoal = true;
        if (key === "oil") hasOil = true;
      }

      // торговые связи
      g += Math.min(s.links.size, 5) * 0.003;

      // Индустриализация — там, где добывают индустриальные ресурсы (своя шахта
      // нефти/руды/угля) либо в крупном городе, который их подвозит по торговле.
      const ownsIndustrial = ownedKeys.has("oil") || ownedKeys.has("iron") || ownedKeys.has("coal");
      const canIndustry = (hasIron && hasCoal) || hasOil;
      if (canIndustry && (ownsIndustrial || s.pop > 10000) && s.industry < 3 && this._rand() < 0.1) {
        s.industry++;
      }
      g += s.industry * 0.012;

      // Агломерация: крупные растут быстрее («богатые богатеют») — так из общей
      // массы выделяются города и редкие мегаполисы, а не «всё посёлки».
      g += Math.min(0.03, Math.max(0, (Math.log10(Math.max(1, s.pop)) - 3) * 0.025));

      // подавление роста рядом с более крупным соседом (пригороды, а не города)
      for (const o of alive) {
        if (o === s || o.pop <= s.pop) continue;
        const dCells = Math.hypot(o.x - s.x, o.y - s.y);
        if (dCells * this.cellKm < 10) { g -= 0.025; break; }
      }

      g = Math.max(0, Math.min(0.12, g)) * (0.85 + this._rand() * 0.3);
      s.pop *= 1 + g;
      s.tier = this._tierFor(s.pop);
    }

    // 3) Освоение ресурсов: каждый пункт ведёт максимум одну стройку.
    for (const s of alive) this._advanceProject(s, t, access.get(s.id));

    // 4) Торговые дороги: пункт периодически тянет дорогу к ближайшему
    //    несоединённому соседу (если дорос).
    for (const s of alive) this._maybeTradeRoad(s, alive, t);
  }

  /* Текущий «вид» по населению. */
  _tierFor(pop) {
    let tier = 0;
    for (let i = TIER_POP.length - 1; i >= 0; i--) {
      if (pop >= TIER_POP[i]) { tier = i; break; }
    }
    return tier;
  }

  /*
   * Доступ к ресурсам по компонентам связности дорог: внутри одной соединённой
   * группы пунктов доступны все освоенные ресурсы группы (торговля).
   */
  _tradeAccess(alive) {
    // Объединение по торговым связям (union-find на лету через BFS).
    const idToS = new Map(alive.map((s) => [s.id, s]));
    const seen = new Set();
    const access = new Map();
    for (const s of alive) {
      if (seen.has(s.id)) continue;
      // компонента s
      const comp = [];
      const stack = [s.id];
      while (stack.length) {
        const id = stack.pop();
        if (seen.has(id)) continue;
        seen.add(id);
        const node = idToS.get(id);
        if (!node) continue;
        comp.push(node);
        for (const n of node.links) if (!seen.has(n) && idToS.has(n)) stack.push(n);
      }
      // объединённый доступ к ресурсам компоненты
      const keys = new Set();
      for (const node of comp) {
        for (const resId of node.owned) keys.add(this.resources[resId].type);
      }
      for (const node of comp) access.set(node.id, keys);
    }
    return access;
  }

  /* Развитие стройки шахты / выбор новой цели для освоения ресурса. */
  _advanceProject(s, t, accKeys) {
    if (s.project) {
      s.project.mineProgress += 0.18 + this._rand() * 0.12;
      if (s.project.mineProgress >= 1) {
        const res = this.resources[s.project.resId];
        res.state = "mine";
        res.owner = s.id;
        res.mineTick = t;
        s.owned.add(res.id);
        s.project = null;
      }
      return;
    }
    // Берёмся за новый ресурс, только если пункт достаточно вырос.
    if (s.pop < 1200) return;
    // ближайший НЕ освоенный ресурс в пределах досягаемости
    const maxCells = this.size * 0.33;
    let best = -1, bestScore = -Infinity;
    for (const r of this.resources) {
      if (r.state !== "raw") continue;
      const d = Math.hypot(r.x - s.x, r.y - s.y);
      if (d > maxCells) continue;
      const rt = RESOURCE_BY_KEY[r.type];
      const value = (rt ? rt.growth + rt.industry : 0.2) * r.amount;
      const score = value - d / this.size; // ценность минус удалённость
      if (score > bestScore) { bestScore = score; best = r.id; }
    }
    if (best < 0) return;
    // тянем подъездную дорогу и начинаем шахту
    const r = this.resources[best];
    const path = this._road(s.x, s.y, r.x, r.y);
    this.roads.push({ from: s.id, resId: best, path, klass: "local", kind: "resource", builtTick: t });
    s.project = { resId: best, mineProgress: 0 };
  }

  /*
   * Торговая дорога к ближайшему соседу. Чтобы сеть не превращалась в кашу:
   *   - не больше 3 прямых связей у пункта;
   *   - тянем в основном к ещё НЕ присоединённой части сети (объединяем кластеры);
   *   - избыточные «петли» внутри уже связанной сети — лишь изредка.
   */
  _maybeTradeRoad(s, alive, t) {
    if (s.pop < 900 || s.links.size >= 3) return;
    if (this._rand() > 0.5) return; // не каждый тик
    let best = null, bestD = Infinity;
    for (const o of alive) {
      if (o.id === s.id || s.links.has(o.id)) continue;
      const d = Math.hypot(o.x - s.x, o.y - s.y);
      if (d < bestD) { bestD = d; best = o; }
    }
    if (!best || bestD > this.size * 0.45) return;
    // Уже соединены через сеть? Тогда лишняя прямая дорога — редко (петля).
    if (this._connected(s.id, best.id) && this._rand() > 0.15) return;

    const path = this._road(s.x, s.y, best.x, best.y);
    this.roads.push({ from: s.id, to: best.id, path, klass: "main", kind: "trade", builtTick: t });
    s.links.add(best.id);
    best.links.add(s.id);
  }

  /* Соединены ли два пункта через сеть торговых дорог (BFS по связям)? */
  _connected(aId, bId) {
    if (aId === bId) return true;
    if (!this._byId) this._byId = new Map(this.settlements.map((s) => [s.id, s]));
    const seen = new Set([aId]);
    const stack = [aId];
    while (stack.length) {
      const node = this._byId.get(stack.pop());
      if (!node) continue;
      for (const n of node.links) {
        if (n === bId) return true;
        if (!seen.has(n)) { seen.add(n); stack.push(n); }
      }
    }
    return false;
  }

  /* Прокладка дороги по рельефу (A*), со сглаживанием; запасной вариант — прямая. */
  _road(sx, sy, gx, gy) {
    let path = this.gen._aStar(this.cost, this.height, sx, sy, gx, gy);
    if (!path || path.length < 2) path = [[sx, sy], [gx, gy]];
    path = this.gen._smoothPath(this.gen._decimate(path, this._stride));
    path[0] = [sx, sy];
    path[path.length - 1] = [gx, gy];
    return path;
  }
}
