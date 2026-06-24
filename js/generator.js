/*
 * generator.js — процедурная генерация местности.
 *
 * Здесь мы не рисуем карту, а строим её «модель» — данные о том, что где находится:
 *   - массив высот (рельеф) и уклонов,
 *   - тип поверхности в каждой клетке (вода / песок / поле / лес / возвышенность),
 *   - реки (русла, проложенные вниз по склону),
 *   - список населённых пунктов с их «видом» (от деревни до мегаполиса),
 *   - сеть дорог, проложенную ПО РЕЛЬЕФУ (в обход воды и крутых склонов).
 *
 * Отрисовкой займётся отдельный модуль renderer.js. Такое разделение
 * («данные» отдельно, «картинка» отдельно) — важный приём в программировании:
 * одну и ту же модель можно нарисовать по-разному.
 */

// Типы поверхности. Используем константы, чтобы не путаться в «магических числах».
const TERRAIN = {
  WATER: 0,  // вода (реки, озёра, море)
  SAND: 1,   // песок / отмель у воды
  FIELD: 2,  // открытое поле / луг
  FOREST: 3, // лес
  HILL: 4,   // возвышенность / горы
};

// Классы дорог — влияют на ширину линии и приоритет отрисовки.
const ROAD_CLASS = {
  HIGHWAY: "highway", // магистраль между крупными городами
  MAIN: "main",       // обычная дорога между посёлками
  LOCAL: "local",     // местная дорога к малым сёлам и деревням
};

/*
 * Виды населённых пунктов — от деревни до мегаполиса.
 * Каждый вид (tier, «ранг» 0..4) задаёт свой размер, плотность застройки,
 * число главных улиц, долю гражданских/промышленных зданий и стиль названия.
 *   radiusFrac — охват пункта как доля размера карты (чтобы масштаб не «плыл»
 *                при смене разрешения).
 */
const SETTLEMENT_TIERS = [
  { key: "hamlet",     label: "деревня",   radiusFrac: 0.014, density: 0.50, branchMul: 0.5, civic: 0.04, industrial: 0.00, grid: false, mainRoads: 1, labelScale: 0.80 },
  { key: "village",    label: "село",      radiusFrac: 0.022, density: 0.66, branchMul: 0.8, civic: 0.12, industrial: 0.05, grid: false, mainRoads: 2, labelScale: 0.95 },
  { key: "town",       label: "посёлок",   radiusFrac: 0.035, density: 0.82, branchMul: 1.0, civic: 0.22, industrial: 0.12, grid: false, mainRoads: 2, labelScale: 1.12 },
  { key: "city",       label: "город",     radiusFrac: 0.053, density: 0.92, branchMul: 1.3, civic: 0.32, industrial: 0.20, grid: true,  mainRoads: 3, labelScale: 1.34 },
  { key: "metropolis", label: "мегаполис", radiusFrac: 0.080, density: 1.00, branchMul: 1.6, civic: 0.42, industrial: 0.28, grid: true,  mainRoads: 4, labelScale: 1.62 },
];

/*
 * Двоичная куча (min-heap) — очередь с приоритетом для алгоритма A*.
 * Хранит элементы (целые индексы клеток) и их приоритеты; всегда быстро
 * достаёт элемент с наименьшим приоритетом. Без неё поиск пути был бы медленным.
 */
class MinHeap {
  constructor() {
    this.items = [];
    this.prio = [];
  }
  get size() {
    return this.items.length;
  }
  push(item, p) {
    this.items.push(item);
    this.prio.push(p);
    let i = this.items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.prio[parent] <= this.prio[i]) break;
      this._swap(i, parent);
      i = parent;
    }
  }
  pop() {
    const top = this.items[0];
    const last = this.items.length - 1;
    this._swap(0, last);
    this.items.pop();
    this.prio.pop();
    let i = 0;
    const n = this.items.length;
    while (true) {
      const l = i * 2 + 1;
      const r = i * 2 + 2;
      let s = i;
      if (l < n && this.prio[l] < this.prio[s]) s = l;
      if (r < n && this.prio[r] < this.prio[s]) s = r;
      if (s === i) break;
      this._swap(i, s);
      i = s;
    }
    return top;
  }
  _swap(a, b) {
    const ti = this.items[a]; this.items[a] = this.items[b]; this.items[b] = ti;
    const tp = this.prio[a]; this.prio[a] = this.prio[b]; this.prio[b] = tp;
  }
}

class MapGenerator {
  /*
   * options:
   *   seed     — зерно генерации
   *   size     — размер сетки (size x size клеток); больше = выше разрешение
   *   seaLevel — уровень воды (0..1): всё ниже считается водой
   *   forest   — лесистость (0..1)
   *   townCount — желаемое число населённых пунктов
   */
  constructor(options) {
    this.size = options.size;
    this.seed = options.seed >>> 0;
    this.seaLevel = options.seaLevel;
    this.forestAmount = options.forest;
    this.townCount = options.townCount;

    // Два независимых шума: один для высот, другой для влажности (распределение леса).
    this.heightNoise = new Noise(options.seed);
    this.moistNoise = new Noise(options.seed + 9999);

    // Свой генератор случайных чисел (тоже от сида), чтобы результат был воспроизводим.
    this._rngState = (options.seed + 1) >>> 0;
  }

  /* Простой детерминированный ГПСЧ (генератор псевдослучайных чисел) в [0,1). */
  _rand() {
    // алгоритм mulberry32 — короткий и качественный
    this._rngState |= 0;
    this._rngState = (this._rngState + 0x6d2b79f5) | 0;
    let t = Math.imul(this._rngState ^ (this._rngState >>> 15), 1 | this._rngState);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /* Индекс в одномерном массиве по координатам (x, y) сетки. */
  _idx(x, y) {
    return y * this.size + x;
  }

  /*
   * Растягивает значения массива на весь диапазон [0,1]:
   * находим минимум и максимум и линейно переносим в [0,1]. Меняет массив на месте.
   */
  _normalize(arr) {
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < arr.length; i++) {
      if (arr[i] < min) min = arr[i];
      if (arr[i] > max) max = arr[i];
    }
    const range = max - min;
    if (range === 0) return;
    for (let i = 0; i < arr.length; i++) {
      arr[i] = (arr[i] - min) / range;
    }
  }

  /*
   * Главный метод: генерирует и возвращает готовую модель карты.
   * Порядок важен: рельеф → классификация → реки → уклоны → города → дороги → застройка.
   */
  generate() {
    const size = this.size;
    const height = new Float32Array(size * size);
    const moisture = new Float32Array(size * size);
    const type = new Uint8Array(size * size);

    // 1) Высоты и влажность через фрактальный шум
    this._computeFields(height, moisture);
    this._normalize(height);
    this._normalize(moisture);

    // 2) Классификация: по высоте и влажности определяем тип поверхности
    this._classify(height, moisture, type);

    // 3) Реки: прокладываем русла вниз по склону и помечаем их как воду.
    //    Благодаря этому дороги будут вынуждены искать брод/мост, а города —
    //    селиться у воды, как в реальности.
    const rivers = this._carveRivers(height, type);

    // 4) Поле уклонов (крутизны): нужно и для дорог (объезд гор), и для
    //    размещения/застройки городов (не строим на круче).
    const slope = this._computeSlope(height);

    // 5) Населённые пункты и их виды (деревня…мегаполис)
    const towns = this._placeTowns(height, slope, type);
    this._assignTiers(towns);

    // 6) Сеть дорог с учётом рельефа (поиск пути A* по «стоимости» местности)
    const cost = this._buildCostField(height, slope, type);
    const roads = this._buildRoadNetwork(towns, cost, height, size);

    // 7) Запоминаем, с каких направлений в город входят трассы — чтобы главные
    //    улицы стыковались с магистралями, а не торчали в случайные стороны.
    this._collectIncomingRoads(towns, roads);

    // 8) Детальная застройка каждого пункта (дома, улицы, кварталы) — с учётом вида
    const builder = new TownBuilder(this.seed);
    for (const town of towns) {
      builder.build(town, { type, size, slope, height });
    }

    return {
      size,
      seaLevel: this.seaLevel,
      height,
      moisture,
      type,
      slope,
      rivers,
      towns,
      roads,
    };
  }

  /*
   * Заполняет массивы высот и влажности фрактальным шумом.
   * «Островной» эффект (понижение к краям) + domain warping для неровной
   * береговой линии остаются как раньше — это и даёт законченный вид карты.
   */
  _computeFields(height, moisture) {
    const size = this.size;
    // Чем крупнее сетка, тем больше «октав» детализации можем себе позволить.
    const octaves = size >= 448 ? 7 : 6;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const nx = x / size;
        const ny = y / size;

        let h = this.heightNoise.fractal(nx * 4, ny * 4, octaves, 1);

        const dx = nx - 0.5;
        const dy = ny - 0.5;
        // Искажаем расстояние низкочастотным шумом (domain warping), чтобы
        // береговая линия была неровной, а не идеально круглой.
        const warp = (this.heightNoise.value(nx * 3 + 50, ny * 3 + 50) - 0.5) * 0.35;
        const dist = (Math.sqrt(dx * dx + dy * dy) + warp) * 2;
        const falloff = Math.max(0, 1 - dist * dist * 0.9);
        h = h * 0.6 + falloff * 0.4;

        height[this._idx(x, y)] = h;
        moisture[this._idx(x, y)] = this.moistNoise.fractal(nx * 5, ny * 5, 4, 1);
      }
    }
  }

  /* Классификация клеток в типы поверхности по высоте и влажности. */
  _classify(height, moisture, type) {
    const sea = this.seaLevel;
    for (let i = 0; i < height.length; i++) {
      const h = height[i];
      const m = moisture[i];
      if (h < sea) {
        type[i] = TERRAIN.WATER;
      } else if (h < sea + 0.025) {
        type[i] = TERRAIN.SAND; // узкая полоса побережья
      } else if (h > 0.82) {
        type[i] = TERRAIN.HILL; // высоко — возвышенности
      } else {
        const forestThreshold = 1 - this.forestAmount;
        type[i] = m > forestThreshold ? TERRAIN.FOREST : TERRAIN.FIELD;
      }
    }
  }

  /*
   * Реки. Берём несколько «истоков» на возвышенностях и спускаемся из каждого
   * вниз по самому крутому склону до моря/озера или до впадины. Клетки русла
   * помечаем водой. Возвращаем список рек (полилиний) — их же нарисует renderer.
   */
  _carveRivers(height, type) {
    const size = this.size;
    const rivers = [];
    const target = Math.round(3 + size / 200); // примерное число рек
    const maxTries = target * 60;
    let tries = 0;
    while (rivers.length < target && tries < maxTries) {
      tries++;
      const sx = Math.floor(this._rand() * size);
      const sy = Math.floor(this._rand() * size);
      if (height[sy * size + sx] < 0.6) continue; // истоки — только высоко
      const path = this._traceRiver(height, type, sx, sy);
      if (path.length < Math.max(10, size * 0.06)) continue; // короткие отбрасываем
      for (const [x, y] of path) {
        type[y * size + x] = TERRAIN.WATER; // прорезаем русло
      }
      rivers.push(path);
    }
    return rivers;
  }

  /* Прослеживает одно русло «стеканием» вниз по склону из точки (x, y). */
  _traceRiver(height, type, x, y) {
    const size = this.size;
    const path = [[x, y]];
    const visited = new Set([y * size + x]);
    let px = x;
    let py = y;
    let dirx = 0;
    let diry = 0;
    const maxLen = Math.floor(size * 1.5);
    for (let step = 0; step < maxLen; step++) {
      if (step > 0 && type[py * size + px] === TERRAIN.WATER) break; // впали в воду
      if (height[py * size + px] < this.seaLevel) break;

      // Ищем самого «низкого» соседа; небольшая инерция держит русло прямее.
      let bx = -1;
      let by = -1;
      let bestScore = Infinity;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = px + dx;
          const ny = py + dy;
          if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
          if (visited.has(ny * size + nx)) continue;
          const inertia = dx === dirx && dy === diry ? -0.004 : 0;
          const score = height[ny * size + nx] + inertia;
          if (score < bestScore) { bestScore = score; bx = nx; by = ny; }
        }
      }
      if (bx < 0) break; // тупик (всё вокруг уже посещено)
      if (height[by * size + bx] > height[py * size + px] + 0.025) break; // впадина — конец реки

      dirx = Math.sign(bx - px);
      diry = Math.sign(by - py);
      px = bx;
      py = by;
      visited.add(py * size + px);
      path.push([px, py]);
    }
    return path;
  }

  /*
   * Поле уклонов: для каждой клетки — величина наклона рельефа (модуль градиента).
   * Чем круче, тем хуже для дорог и застройки.
   */
  _computeSlope(height) {
    const size = this.size;
    const slope = new Float32Array(size * size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const xl = x > 0 ? x - 1 : x;
        const xr = x < size - 1 ? x + 1 : x;
        const yt = y > 0 ? y - 1 : y;
        const yb = y < size - 1 ? y + 1 : y;
        const dzdx = height[y * size + xr] - height[y * size + xl];
        const dzdy = height[yb * size + x] - height[yt * size + x];
        slope[y * size + x] = Math.sqrt(dzdx * dzdx + dzdy * dzdy);
      }
    }
    return slope;
  }

  /*
   * «Стоимость» прохода через каждую клетку для прокладки дорог.
   * Дорога будет искать путь наименьшей суммарной стоимости, поэтому:
   *   - вода очень дорогая (дорогу тянет в обход; пересечёт только узко = мост),
   *   - крутизна — главный штраф (дороги вьются по пологому),
   *   - лес чуть дороже поля, горы — заметно дороже.
   */
  _buildCostField(height, slope, type) {
    const n = this.size * this.size;
    const cost = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let c = 1;
      const t = type[i];
      if (t === TERRAIN.WATER) c += 40;
      else if (t === TERRAIN.HILL) c += 3;
      else if (t === TERRAIN.FOREST) c += 0.6;
      else if (t === TERRAIN.SAND) c += 0.3;
      c += slope[i] * 60; // крутизна — основной фактор
      cost[i] = c;
    }
    return cost;
  }

  /*
   * Поиск пути A* по сетке стоимостей от (sx,sy) к (gx,gy).
   * Помимо стоимости клетки учитываем «набор высоты» при переходе — так
   * дороги предпочитают идти вдоль горизонталей (по долинам), а не в лоб на гору.
   * Возвращает массив точек [x,y] либо null, если путь не найден.
   */
  _aStar(cost, height, sx, sy, gx, gy) {
    const size = this.size;
    const n = size * size;
    const start = sy * size + sx;
    const goal = gy * size + gx;

    const g = new Float32Array(n); g.fill(Infinity);
    const came = new Int32Array(n); came.fill(-1);
    const closed = new Uint8Array(n);
    const open = new MinHeap();

    const climbW = 130; // насколько штрафуем подъём/спуск между клетками
    g[start] = 0;
    open.push(start, this._heuristic(start, goal, size));

    let expansions = 0;
    const maxExpansions = n; // предохранитель от зацикливания

    while (open.size > 0) {
      const cur = open.pop();
      if (cur === goal) return this._reconstruct(came, cur, size);
      if (closed[cur]) continue;
      closed[cur] = 1;
      if (++expansions > maxExpansions) break;

      const cx = cur % size;
      const cy = (cur / size) | 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = cx + dx;
          const ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
          const ni = ny * size + nx;
          if (closed[ni]) continue;
          const diag = dx && dy ? 1.41421356 : 1;
          const climb = Math.abs(height[ni] - height[cur]) * climbW;
          const stepCost = (cost[cur] + cost[ni]) * 0.5 * diag + climb;
          const ng = g[cur] + stepCost;
          if (ng < g[ni]) {
            g[ni] = ng;
            came[ni] = cur;
            open.push(ni, ng + this._heuristic(ni, goal, size));
          }
        }
      }
    }
    return null;
  }

  /* Эвристика A* — прямое евклидово расстояние до цели (в клетках). */
  _heuristic(a, goal, size) {
    const ax = a % size;
    const ay = (a / size) | 0;
    const gx = goal % size;
    const gy = (goal / size) | 0;
    const dx = ax - gx;
    const dy = ay - gy;
    return Math.sqrt(dx * dx + dy * dy);
  }

  /* Восстанавливает путь, идя по ссылкам «откуда пришли» от цели к старту. */
  _reconstruct(came, cur, size) {
    const path = [];
    let c = cur;
    while (c !== -1) {
      path.push([c % size, (c / size) | 0]);
      c = came[c];
    }
    path.reverse();
    return path;
  }

  /*
   * Строит сеть дорог между населёнными пунктами.
   * Сначала выбираем, КТО с кем связан (жадное минимальное остовное дерево по
   * прямым расстояниям + несколько кольцевых связей между близкими пунктами),
   * а затем КАЖДУЮ связь прокладываем по рельефу через A* и сглаживаем.
   */
  _buildRoadNetwork(towns, cost, height, size) {
    if (towns.length < 2) return [];
    const n = towns.length;

    // 1) Топология: минимальное остовное дерево (как раньше — «жадное дерево»).
    const edges = [];
    const connected = new Set([0]);
    const remaining = new Set();
    for (let i = 1; i < n; i++) remaining.add(i);
    while (remaining.size > 0) {
      let best = Infinity;
      let bf = -1;
      let bt = -1;
      for (const c of connected) {
        for (const r of remaining) {
          const dx = towns[c].x - towns[r].x;
          const dy = towns[c].y - towns[r].y;
          const d = dx * dx + dy * dy;
          if (d < best) { best = d; bf = c; bt = r; }
        }
      }
      edges.push([bf, bt]);
      connected.add(bt);
      remaining.delete(bt);
    }

    // 2) Немного «кольцевых» связей между близкими пунктами — реальные дорожные
    //    сети не деревья, в них есть петли. Берём ограниченное число.
    const inTree = new Set();
    for (const [a, b] of edges) { inTree.add(a + "-" + b); inTree.add(b + "-" + a); }
    const extra = [];
    for (let a = 0; a < n; a++) {
      for (let b = a + 1; b < n; b++) {
        if (inTree.has(a + "-" + b)) continue;
        const dx = towns[a].x - towns[b].x;
        const dy = towns[a].y - towns[b].y;
        if (Math.sqrt(dx * dx + dy * dy) < size * 0.28 && this._rand() < 0.35) {
          extra.push([a, b]);
        }
      }
    }
    const all = edges.concat(extra.slice(0, Math.ceil(n / 3)));

    // 3) Каждую связь прокладываем по рельефу.
    const stride = Math.max(2, Math.round(size / 120));
    const roads = [];
    for (const [a, b] of all) {
      const ta = towns[a];
      const tb = towns[b];
      let path = this._aStar(cost, height, ta.x, ta.y, tb.x, tb.y);
      if (!path || path.length < 2) path = [[ta.x, ta.y], [tb.x, tb.y]];
      path = this._smoothPath(this._decimate(path, stride));
      path[0] = [ta.x, ta.y];
      path[path.length - 1] = [tb.x, tb.y];
      roads.push({ from: a, to: b, path, klass: this._roadClass(ta, tb) });
    }
    return roads;
  }

  /* Класс дороги по «старшему» из двух пунктов: магистраль / дорога / местная. */
  _roadClass(a, b) {
    const t = Math.max(a.tier || 0, b.tier || 0);
    if (t >= 3) return ROAD_CLASS.HIGHWAY;
    if (t === 2) return ROAD_CLASS.MAIN;
    return ROAD_CLASS.LOCAL;
  }

  /* Прореживает путь, оставляя каждую stride-ю точку (концы сохраняем). */
  _decimate(path, stride) {
    if (path.length <= 2) return path.slice();
    const out = [path[0]];
    for (let i = stride; i < path.length - 1; i += stride) out.push(path[i]);
    out.push(path[path.length - 1]);
    return out;
  }

  /* Сглаживание ломаной по схеме Чайкина (срезаем углы) — дорога становится плавной. */
  _smoothPath(path) {
    if (path.length < 3) return path.slice();
    let pts = path;
    for (let it = 0; it < 2; it++) {
      const out = [pts[0]];
      for (let i = 0; i < pts.length - 1; i++) {
        const p = pts[i];
        const q = pts[i + 1];
        out.push([p[0] * 0.75 + q[0] * 0.25, p[1] * 0.75 + q[1] * 0.25]);
        out.push([p[0] * 0.25 + q[0] * 0.75, p[1] * 0.25 + q[1] * 0.75]);
      }
      out.push(pts[pts.length - 1]);
      pts = out;
    }
    return pts;
  }

  /* Для каждого пункта собираем углы входящих дорог (для стыковки улиц с трассами). */
  _collectIncomingRoads(towns, roads) {
    for (const t of towns) t.incoming = [];
    for (const road of roads) {
      const p = road.path;
      if (p.length < 2) continue;
      const a = towns[road.from];
      const b = towns[road.to];
      a.incoming.push(Math.atan2(p[1][1] - a.y, p[1][0] - a.x));
      const pen = p[p.length - 2];
      b.incoming.push(Math.atan2(pen[1] - b.y, pen[0] - b.x));
    }
  }

  /*
   * Размещение населённых пунктов.
   * Правила: ставим на суше (не в воде/горах), на достаточно ровном месте и не
   * слишком близко к другим. Дополнительно считаем «пригодность» места
   * (ровно + рядом вода + невысоко) — она нужна, чтобы лучшие места стали
   * крупными городами, а слабые — деревнями.
   */
  _placeTowns(height, slope, type) {
    const size = this.size;
    const towns = [];
    const minDist = size / (this.townCount + 1);
    const minDist2 = minDist * minDist;
    const margin = Math.round(size * 0.045); // не селим у самой кромки карты

    // Два прохода: сначала с порогом пригодности (отбираем хорошие места),
    // затем, если не добрали, — без порога, лишь бы на суше и не вплотную.
    for (const strict of [true, false]) {
      let attempts = 0;
      const maxAttempts = this.townCount * 300;
      while (towns.length < this.townCount && attempts < maxAttempts) {
        attempts++;
        const x = Math.floor(this._rand() * size);
        const y = Math.floor(this._rand() * size);
        if (x < margin || y < margin || x >= size - margin || y >= size - margin) continue;
        const i = y * size + x;
        const t = type[i];
        if (t === TERRAIN.WATER || t === TERRAIN.HILL) continue;
        if (strict && slope[i] > 0.05) continue; // на круче не строим

        let tooClose = false;
        for (const tw of towns) {
          const dx = tw.x - x;
          const dy = tw.y - y;
          if (dx * dx + dy * dy < minDist2) { tooClose = true; break; }
        }
        if (tooClose) continue;

        const suit = this._suitability(height, slope, type, x, y);
        if (strict && suit < 0.3) continue;

        towns.push({ x, y, suit });
      }
    }
    return towns;
  }

  /*
   * «Пригодность» места для крупного пункта: ровно (0.5) + рядом вода (0.3) +
   * умеренная высота над морем (0.2). Значение в [0,1].
   */
  _suitability(height, slope, type, x, y) {
    const size = this.size;
    const i = y * size + x;
    const flat = Math.max(0, 1 - slope[i] * 30);

    // Близость к воде (река/озеро/море) в небольшом радиусе.
    const R = Math.max(3, Math.round(size * 0.03));
    let water = 0;
    for (let r = 2; r <= R && water === 0; r += 2) {
      for (let a = 0; a < 8; a++) {
        const ang = (a / 8) * Math.PI * 2;
        const nx = Math.round(x + Math.cos(ang) * r);
        const ny = Math.round(y + Math.sin(ang) * r);
        if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
        if (type[ny * size + nx] === TERRAIN.WATER) { water = 1 - (r / R) * 0.5; break; }
      }
    }

    const low = Math.max(0, 1 - Math.abs(height[i] - (this.seaLevel + 0.12)) * 2);

    // Центральность: ближе к середине карты — чуть пригоднее. Благодаря этому
    // самые крупные пункты (берутся из самых пригодных мест) тяготеют к центру,
    // а не лепятся к краю, где их «обрезает» рамка.
    const cxn = x / size - 0.5;
    const cyn = y / size - 0.5;
    const central = Math.max(0, 1 - Math.hypot(cxn, cyn) * 1.6);

    return flat * 0.45 + water * 0.25 + low * 0.15 + central * 0.15;
  }

  /*
   * Назначает каждому пункту «вид» (деревня…мегаполис) по правилу «ранг-размер»:
   * лучших мест мало, и они становятся крупными городами; большинство — сёла и
   * деревни. Заодно выдаём название, охват (radius) и совместимое поле size.
   */
  _assignTiers(towns) {
    const N = towns.length;
    // Лучшие по пригодности места — в начало (станут крупными пунктами).
    const order = towns.map((_, idx) => idx).sort((a, b) => towns[b].suit - towns[a].suit);

    for (let rank = 0; rank < N; rank++) {
      const t = towns[order[rank]];
      const frac = N > 1 ? rank / (N - 1) : 0;

      let tier;
      if (rank === 0 && N >= 7) tier = 4;       // единственный мегаполис на большой карте
      else if (frac < 0.15) tier = 3;           // города
      else if (frac < 0.40) tier = 2;           // посёлки
      else if (frac < 0.72) tier = 1;           // сёла
      else tier = 0;                            // деревни

      // Небольшая случайная вариация ±1 уровень — для разнообразия.
      const r = this._rand();
      if (r < 0.12 && tier < 4) tier++;
      else if (r > 0.90 && tier > 0) tier--;

      const def = SETTLEMENT_TIERS[tier];
      t.tier = tier;
      t.kind = def.key;
      t.kindLabel = def.label;
      t.radius = Math.max(4, def.radiusFrac * this.size * (0.85 + this._rand() * 0.3));
      t.size = 0.4 + tier * 0.18; // обратная совместимость со старым полем
      t.name = this._settlementName(tier, rank);
    }
  }

  /*
   * Генерация русскоязычного названия в зависимости от вида пункта:
   * города — на -ск/-град/-горск, посёлки — на -ово/-поль, сёла и деревни —
   * на -овка/-ино/-ки. Следим, чтобы названия не повторялись.
   */
  _settlementName(tier, salt) {
    const roots = [
      "Дуб", "Берёз", "Камен", "Сосн", "Ольх", "Лип", "Клён", "Вишн", "Ясен",
      "Озёр", "Луг", "Холм", "Бор", "Тих", "Бел", "Красн", "Чёрн", "Зелен",
      "Север", "Гор", "Стар", "Нов", "Велик", "Мал", "Песч", "Глин", "Соль",
      "Рыб", "Медвеж", "Волч", "Журавл", "Соколь", "Вербн", "Ивн", "Топол",
      "Гранит", "Кремн", "Полев", "Заречь", "Покров",
    ];
    let suf;
    if (tier >= 3) suf = ["ск", "град", "горск", "поль", "бург"];
    else if (tier === 2) suf = ["ово", "поль", "ный", "инск", "овск"];
    else suf = ["овка", "инка", "ино", "ёвка", "ки", "евка"];

    if (!this._usedNames) this._usedNames = new Set();
    for (let attempt = 0; attempt < 24; attempt++) {
      const root = roots[Math.floor(this._rand() * roots.length)];
      const s = suf[Math.floor(this._rand() * suf.length)];
      const name = root + s;
      if (!this._usedNames.has(name)) { this._usedNames.add(name); return name; }
    }
    // Запасной вариант — гарантированно уникальный.
    const fallback = roots[salt % roots.length] + (tier >= 3 ? "ск" : "овка") + "-" + (salt + 1);
    this._usedNames.add(fallback);
    return fallback;
  }
}
