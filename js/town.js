/*
 * town.js — застройка населённого пункта КВАРТАЛАМИ (как на настоящих картах).
 *
 * Идея реализма: город — это не «дома вдоль линий», а СЕТКА УЛИЦ, которая делит
 * территорию на КВАРТАЛЫ, а уже внутри кварталов застройка идёт по периметру
 * (дома фасадами на улицу, внутри — двор). Часть кварталов — ПАРКИ/скверы.
 *
 *   - улицы образуют сетку (с лёгкой неровностью и главными «проспектами»);
 *   - квартал застраивается по периметру (жильё) либо одним крупным зданием
 *     (гражданское/промышленное); часть кварталов — зелёные парки;
 *   - зонирование: центр (гражданские здания, площадь), жильё, промзона на
 *     окраине; чем дальше от центра — тем больше парков и реже застройка.
 *
 * Координаты — в «клетках» сетки карты. Всё детерминировано: один и тот же
 * пункт (координаты + сид) застраивается одинаково.
 */

class TownBuilder {
  /** @param {number} seed — общий сид карты */
  constructor(seed) {
    this.seed = seed >>> 0;
  }

  /* Детерминированный ГПСЧ для конкретного пункта (зависит от его координат). */
  _rng(a, b) {
    let s = (this.seed ^ Math.imul(a | 0, 73856093) ^ Math.imul(b | 0, 19349663)) >>> 0;
    return function () {
      s = (s + 0x6d2b79f5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* Сколько кварталов по стороне у пункта данного вида. */
  _blocksPerAxis(tier) {
    return [2, 3, 5, 8, 11][tier] || 4;
  }

  /* Локальные координаты (u вдоль оси города, v поперёк) → мировые клетки. */
  _toWorld(f, u, v) {
    return [f.cx + u * f.ca - v * f.sa, f.cy + u * f.sa + v * f.ca];
  }

  /* Позиции линий сетки от -R до R (внутренние — со случайным сдвигом). */
  _gridPositions(N, R, rng) {
    const pos = [];
    const cell = (2 * R) / N;
    for (let i = 0; i <= N; i++) {
      let p = -R + i * cell;
      if (i > 0 && i < N) p += (rng() - 0.5) * cell * 0.3;
      pos.push(p);
    }
    return pos;
  }

  /*
   * Достраивает town: radius, angle, squareR, streets (улицы), buildings (дома),
   * parks (парки). grid — { type, size, slope, height } для проверки рельефа.
   */
  build(town, grid) {
    const rng = this._rng(town.x, town.y);
    const tier = town.tier | 0;
    const def = SETTLEMENT_TIERS[tier] || SETTLEMENT_TIERS[1];

    const R = town.radius || 5 + (town.size || 0.6) * 9;
    town.radius = R;
    town.squareR = tier >= 2 ? R * 0.14 : 0; // центральная площадь у посёлков+

    const ang = town.incoming && town.incoming.length ? town.incoming[0] : rng() * Math.PI;
    town.angle = ang;
    const f = { cx: town.x, cy: town.y, ca: Math.cos(ang), sa: Math.sin(ang), R };

    const N = this._blocksPerAxis(tier);
    const cell = (2 * R) / N; // размер квартала в клетках
    f.cell = cell;
    const U = this._gridPositions(N, R, rng);
    const V = this._gridPositions(N, R, rng);

    // --- Улицы: линии сетки, обрезанные по кругу города. Центральные — главные. ---
    const streets = [];
    const midU = Math.round(N / 2);
    const midV = Math.round(N / 2);
    for (let i = 0; i <= N; i++) {
      const u = U[i];
      if (Math.abs(u) >= R) continue;
      const vm = Math.sqrt(Math.max(0, R * R - u * u));
      streets.push({ pts: [this._toWorld(f, u, -vm), this._toWorld(f, u, vm)], major: i === midU });
    }
    for (let j = 0; j <= N; j++) {
      const v = V[j];
      if (Math.abs(v) >= R) continue;
      const um = Math.sqrt(Math.max(0, R * R - v * v));
      streets.push({ pts: [this._toWorld(f, -um, v), this._toWorld(f, um, v)], major: j === midV });
    }
    town.streets = streets;

    // --- Кварталы ---
    const indDir = rng() * Math.PI * 2; // сектор промзоны
    const buildings = [];
    const parks = [];
    const placed = [];
    for (let i = 0; i < N; i++) {
      for (let j = 0; j < N; j++) {
        this._buildBlock(f, U[i], U[i + 1], V[j], V[j + 1], town, def, rng, indDir, grid, buildings, parks, placed);
      }
    }

    // Относительное удаление от центра (для «прорастания» при анимации роста).
    for (const b of buildings) b.dc = Math.hypot(b.x - town.x, b.y - town.y) / R;
    town.buildings = buildings;
    town.parks = parks;
  }

  /* Застраивает один квартал [u0,u1]×[v0,v1] (или делает его парком). */
  _buildBlock(f, u0, u1, v0, v1, town, def, rng, indDir, grid, buildings, parks, placed) {
    const cell = f.cell;
    const mu = (u0 + u1) / 2;
    const mv = (v0 + v1) / 2;
    const c = this._toWorld(f, mu, mv);
    const bx = c[0];
    const by = c[1];
    const dist = Math.hypot(bx - f.cx, by - f.cy);
    const dR = dist / f.R;
    if (dR > 1.02) return;                 // вне круга города
    if (this._isBlocked(grid, bx, by)) return; // вода/круча
    if (town.squareR && dist < town.squareR) return; // центральная площадь — открыта

    const angToC = Math.atan2(by - f.cy, bx - f.cx);
    const industrial =
      def.industrial > 0 && dR > 0.55 &&
      Math.abs(this._angDiff(angToC, indDir)) < 0.7 && rng() < def.industrial * 1.6;

    // Парки: чем дальше от центра, тем чаще зелёные кварталы.
    if (!industrial && rng() < 0.1 + dR * 0.1) {
      const inset = cell * 0.12;
      parks.push({
        poly: [
          this._toWorld(f, u0 + inset, v0 + inset),
          this._toWorld(f, u1 - inset, v0 + inset),
          this._toWorld(f, u1 - inset, v1 - inset),
          this._toWorld(f, u0 + inset, v1 - inset),
        ],
        dc: dR,
      });
      return;
    }

    const civic = !industrial && dR < 0.32 && rng() < def.civic;
    const corners = [
      this._toWorld(f, u0, v0),
      this._toWorld(f, u1, v0),
      this._toWorld(f, u1, v1),
      this._toWorld(f, u0, v1),
    ];

    if (industrial || (civic && rng() < 0.6)) {
      // Крупное здание (завод / общественный комплекс) почти во весь квартал.
      const w = cell * (0.6 + rng() * 0.18);
      const h = cell * (0.48 + rng() * 0.2);
      if (this._isBlocked(grid, bx, by)) return;
      const br = 0.5 * Math.hypot(w, h);
      if (this._tooClose(placed, bx, by, br)) return;
      placed.push([bx, by, br]);
      buildings.push({ x: bx, y: by, w, h, angle: f.ca === 0 ? 0 : Math.atan2(f.sa, f.ca), kind: industrial ? "industrial" : "civic", tone: rng() });
    } else {
      this._placePerimeter(corners, bx, by, civic ? "civic" : "house", cell, rng, grid, buildings, placed);
    }
  }

  /*
   * Периметральная застройка квартала: дома фасадами вдоль каждой из четырёх
   * сторон, с небольшим отступом от улицы; внутри остаётся двор.
   */
  _placePerimeter(corners, bx, by, kind, cell, rng, grid, buildings, placed) {
    const depth = cell * 0.24;       // глубина дома (внутрь квартала)
    const setback = cell * 0.1;      // отступ от линии улицы
    const inset = setback + depth / 2;
    const margin = cell * 0.16;      // отступ от углов (чтобы дома не налезали)
    const wMean = kind === "civic" ? cell * 0.5 : cell * 0.34;
    const edges = [[0, 1], [1, 2], [2, 3], [3, 0]];

    for (const [a, b] of edges) {
      const e0 = corners[a];
      const e1 = corners[b];
      const ex = e1[0] - e0[0];
      const ey = e1[1] - e0[1];
      const len = Math.hypot(ex, ey) || 1;
      const dx = ex / len;
      const dy = ey / len;
      // нормаль внутрь квартала (к центру блока)
      let nx = -dy;
      let ny = dx;
      const mx = (e0[0] + e1[0]) / 2;
      const my = (e0[1] + e1[1]) / 2;
      if ((bx - mx) * nx + (by - my) * ny < 0) { nx = -nx; ny = -ny; }

      const usable = len - 2 * margin;
      if (usable <= cell * 0.15) continue;
      const count = Math.max(1, Math.round(usable / (wMean * 1.15)));
      const slot = usable / count;
      for (let k = 0; k < count; k++) {
        if (rng() < 0.12) continue; // разрывы в застройке
        const t = margin + (k + 0.5) * slot;
        const px = e0[0] + dx * t + nx * inset;
        const py = e0[1] + dy * t + ny * inset;
        const w = slot * (0.7 + rng() * 0.22); // вдоль улицы
        const h = depth * (0.8 + rng() * 0.4); // вглубь двора
        if (this._isBlocked(grid, px, py)) continue;
        const br = 0.5 * Math.hypot(w, h);
        if (this._tooClose(placed, px, py, br)) continue;
        placed.push([px, py, br]);
        buildings.push({ x: px, y: py, w, h, angle: Math.atan2(dy, dx), kind, tone: rng() });
      }
    }
  }

  /* Кратчайшая разница двух углов, в диапазоне [-π, π]. */
  _angDiff(a, b) {
    return ((a - b + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
  }

  /*
   * Пересечётся ли новое здание (радиус r) с уже поставленными? Сравниваем
   * расстояние между центрами с суммой радиусов описанных окружностей плюс
   * небольшой зазор — так дома гарантированно не наслаиваются.
   */
  _tooClose(placed, x, y, r) {
    const gap = 0.12;
    for (let i = placed.length - 1; i >= 0; i--) {
      const dx = placed[i][0] - x;
      const dy = placed[i][1] - y;
      const minD = r + placed[i][2] + gap;
      if (dx * dx + dy * dy < minD * minD) return true;
    }
    return false;
  }

  /*
   * Можно ли застраивать клетку под точкой? Нельзя на воде, на крутом склоне и
   * за пределами карты — так город «обтекает» реки, озёра и горы.
   */
  _isBlocked(grid, wx, wy) {
    const x = Math.round(wx);
    const y = Math.round(wy);
    if (x < 0 || y < 0 || x >= grid.size || y >= grid.size) return true;
    const i = y * grid.size + x;
    if (grid.type[i] === TERRAIN.WATER) return true;
    if (grid.slope && grid.slope[i] > 0.06) return true; // слишком круто
    return false;
  }
}
