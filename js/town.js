/*
 * town.js — реалистичная процедурная застройка города.
 *
 * Главная идея реализма: дома стоят НЕ по ровной сетке, а вдоль дорог.
 * Поэтому сначала строим органичную дорожную сеть (изогнутые главные улицы
 * + ветвящиеся второстепенные), а затем расставляем здания вдоль этих дорог
 * с разрывами, разными размерами и падающей к окраине плотностью.
 *
 * Так город на карте выглядит как настоящий населённый пункт на тактической
 * карте, а не как абстрактная клетчатая схема.
 *
 * Всё детерминировано: один и тот же город (его координаты + сид карты)
 * всегда застраивается одинаково. Координаты — в «клетках» сетки карты.
 */

class TownBuilder {
  /** @param {number} seed — общий сид карты */
  constructor(seed) {
    this.seed = seed >>> 0;
  }

  /* Детерминированный ГПСЧ для конкретного города (зависит от его координат). */
  _rng(a, b) {
    let s = (this.seed ^ Math.imul(a | 0, 73856093) ^ Math.imul(b | 0, 19349663)) >>> 0;
    return function () {
      s = (s + 0x6d2b79f5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /*
   * Достраивает town полями: radius, angle, streets (массив полилиний),
   * buildings (массив зданий).
   * grid — { type, size } для проверки, что не строим на воде.
   */
  build(town, grid) {
    const rng = this._rng(town.x, town.y);

    const baseR = 5 + town.size * 9; // общий «охват» города в клетках
    town.radius = baseR;
    town.angle = rng() * Math.PI;

    // --- Дорожная сеть ---
    const roads = [];
    // две главные дороги через центр под разными углами (слегка изогнутые)
    roads.push(this._mainRoad(town, town.angle, baseR, rng));
    roads.push(this._mainRoad(town, town.angle + Math.PI / 2 + (rng() - 0.5) * 0.8, baseR * 0.85, rng));
    // второстепенные ответвления от главных дорог
    const branches = Math.round(4 + town.size * 9);
    for (let i = 0; i < branches; i++) this._addBranch(roads, town, baseR, rng);
    town.streets = roads;

    // --- Застройка вдоль дорог ---
    const indDir = rng() * Math.PI * 2; // направление промзоны (один сектор окраины)
    const placed = []; // уже занятые точки — чтобы дома не налезали друг на друга
    const buildings = [];
    for (const road of roads) {
      this._placeAlongRoad(road, town, baseR, grid, rng, indDir, placed, buildings);
    }
    town.buildings = buildings;
  }

  /*
   * Главная дорога: полилиния от одного края города через центр к другому,
   * с плавным изгибом (параболой), чтобы улица не была идеально прямой.
   */
  _mainRoad(town, angle, length, rng) {
    const ca = Math.cos(angle);
    const sa = Math.sin(angle);
    const px = -sa; // нормаль (вбок)
    const py = ca;
    const bend = (rng() - 0.5) * length * 0.4; // сила изгиба
    const pts = [];
    const steps = 12;
    for (let i = 0; i <= steps; i++) {
      const t = (i / steps) * 2 - 1;          // от -1 до 1
      const along = t * length;
      const curve = (1 - t * t) * bend;       // 0 на концах, максимум в центре
      pts.push([town.x + along * ca + curve * px, town.y + along * sa + curve * py]);
    }
    return pts;
  }

  /*
   * Второстепенная улица: ответвляется от случайной точки одной из главных
   * дорог и уходит наружу (к окраине) под случайным углом, с лёгким изгибом.
   */
  _addBranch(roads, town, baseR, rng) {
    const base = roads[Math.floor(rng() * Math.min(roads.length, 2))];
    const p = base[1 + Math.floor(rng() * (base.length - 2))];

    // направление «наружу» от центра города + случайный поворот
    let dirX = p[0] - town.x;
    let dirY = p[1] - town.y;
    const dl = Math.hypot(dirX, dirY) || 1;
    const a = Math.atan2(dirY / dl, dirX / dl) + (rng() - 0.5) * 1.4;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    const len = baseR * (0.3 + rng() * 0.6);
    const bend = (rng() - 0.5) * len * 0.3;

    const pts = [];
    const steps = 5;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const along = t * len;
      const curve = Math.sin(t * Math.PI) * bend;
      pts.push([p[0] + along * ca + curve * -sa, p[1] + along * sa + curve * ca]);
    }
    roads.push(pts);
  }

  /*
   * Расставляет здания вдоль одной дороги (с обеих сторон).
   * Дома «смотрят» на дорогу: ширина вдоль дороги, глубина — в сторону.
   * Плотность падает к окраине, часть мест пустует (разрывы между домами).
   */
  _placeAlongRoad(road, town, baseR, grid, rng, indDir, placed, buildings) {
    const step = 1.4; // шаг вдоль дороги между возможными домами
    for (let s = 0; s < road.length - 1; s++) {
      const a = road[s];
      const b = road[s + 1];
      const segLen = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (segLen < 1e-6) continue;
      const dirX = (b[0] - a[0]) / segLen;
      const dirY = (b[1] - a[1]) / segLen;
      const nx = -dirY; // нормаль к дороге
      const ny = dirX;
      const roadAngle = Math.atan2(dirY, dirX);

      for (let d = 0; d < segLen; d += step) {
        const px = a[0] + dirX * d;
        const py = a[1] + dirY * d;
        const dist = Math.hypot(px - town.x, py - town.y);
        const dRatio = dist / baseR;
        if (dRatio > 1.05) continue; // вышли за город

        // плотность: ближе к центру — гуще, к окраине — реже
        const density = 0.9 - dRatio * 0.55;

        for (const side of [-1, 1]) {
          if (rng() > density) continue; // разрыв в застройке

          const angToCenter = Math.atan2(py - town.y, px - town.x);
          const industrial = dRatio > 0.5 && Math.abs(this._angDiff(angToCenter, indDir)) < 0.5;

          let kind, w, h, setback;
          if (industrial) {
            kind = "industrial";
            w = 2.2 + rng() * 1.6; // крупные корпуса
            h = 1.5 + rng() * 1.1;
            setback = 1.6;
          } else if (dRatio < 0.32 && rng() < 0.5) {
            kind = "civic";
            w = 1.5 + rng() * 0.9; // здания центра покрупнее
            h = 1.3 + rng() * 0.7;
            setback = 1.1;
          } else {
            kind = "house";
            w = 0.9 + rng() * 0.8; // обычные дома — мелкие
            h = 0.8 + rng() * 0.6;
            setback = 0.9;
          }

          const off = setback + h / 2; // отступ от оси дороги вбок
          const bx = px + nx * side * off;
          const by = py + ny * side * off;

          if (this._isWater(grid, bx, by)) continue;
          if (this._tooClose(placed, bx, by, Math.max(w, h) * 0.7)) continue;

          placed.push([bx, by]);
          buildings.push({
            x: bx,
            y: by,
            w,
            h,
            angle: roadAngle + (rng() - 0.5) * 0.12, // лёгкий разнобой
            kind,
            tone: rng(), // оттенок для разнообразия цвета
          });
        }
      }
    }
  }

  /* Кратчайшая разница двух углов, в диапазоне [-π, π]. */
  _angDiff(a, b) {
    return ((a - b + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
  }

  /* Не слишком ли близко новая точка к уже поставленным зданиям? */
  _tooClose(placed, x, y, minD) {
    const min2 = minD * minD;
    for (let i = placed.length - 1; i >= 0; i--) {
      const dx = placed[i][0] - x;
      const dy = placed[i][1] - y;
      if (dx * dx + dy * dy < min2) return true;
    }
    return false;
  }

  /* Клетка под точкой — вода? (на воде не строим) */
  _isWater(grid, wx, wy) {
    const x = Math.round(wx);
    const y = Math.round(wy);
    if (x < 0 || y < 0 || x >= grid.size || y >= grid.size) return true;
    return grid.type[y * grid.size + x] === TERRAIN.WATER;
  }
}
