/*
 * town.js — реалистичная процедурная застройка населённого пункта.
 *
 * Главная идея реализма: дома стоят НЕ по ровной сетке, а вдоль дорог.
 * Поэтому сначала строим органичную уличную сеть, а затем расставляем здания
 * вдоль улиц с разрывами, разными размерами и падающей к окраине плотностью.
 *
 * Что нового по сравнению с базовой версией:
 *   - ВИД пункта (деревня…мегаполис) задаёт размер, плотность, число улиц,
 *     долю гражданских/промышленных зданий и наличие квартальной сетки;
 *   - главные улицы СТЫКУЮТСЯ с входящими трассами (town.incoming);
 *   - застройка ОБХОДИТ крутые склоны и воду — город «садится» на рельеф.
 *
 * Всё детерминировано: один и тот же пункт (его координаты + сид карты)
 * всегда застраивается одинаково. Координаты — в «клетках» сетки карты.
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

  /*
   * Достраивает town полями: radius, angle, streets (массив полилиний),
   * buildings (массив зданий).
   * grid — { type, size, slope, height } для проверки рельефа.
   */
  build(town, grid) {
    const rng = this._rng(town.x, town.y);
    const tier = town.tier | 0;
    const def = SETTLEMENT_TIERS[tier] || SETTLEMENT_TIERS[1];

    // Охват пункта (в клетках). Берём из модели (зависит от вида), иначе считаем.
    const baseR = town.radius || 5 + (town.size || 0.6) * 9;
    town.radius = baseR;

    // Центральная площадь у посёлков и крупнее: оставляем середину открытой,
    // и гражданские здания встают кольцом вокруг неё — как настоящий центр.
    town.squareR = tier >= 2 ? baseR * 0.16 : 0;

    // --- Уличная сеть ---
    const roads = [];
    // Главные улицы: их направления берём из входящих трасс, чтобы дороги
    // «вливались» в город, а недостающие добираем веером.
    const dirs = this._mainDirections(town, def.mainRoads, rng);
    town.angle = dirs[0];
    for (let k = 0; k < dirs.length; k++) {
      const len = baseR * (k === 0 ? 1 : 0.8 + rng() * 0.25);
      roads.push(this._mainRoad(town, dirs[k], len, rng));
    }
    // Крупные пункты: квартальная сетка в центре + кольцевая дорога.
    if (def.grid) {
      this._addGrid(roads, town, baseR, dirs[0], rng);
      this._addRing(roads, town, baseR * 0.62, rng);
    }
    // Второстепенные ответвления — чем крупнее пункт, тем их больше.
    const branches = Math.round((3 + tier * 4) * def.branchMul);
    for (let i = 0; i < branches; i++) this._addBranch(roads, town, baseR, rng);
    town.streets = roads;

    // --- Застройка вдоль улиц ---
    const indDir = rng() * Math.PI * 2; // направление промзоны (сектор окраины)
    const placed = []; // уже занятые точки — чтобы дома не налезали друг на друга
    const buildings = [];
    for (const road of roads) {
      this._placeAlongRoad(road, town, baseR, grid, rng, indDir, placed, buildings, def);
    }
    // У деревень и сёл — несколько отдельных дворов/хуторов на окраине.
    if (tier <= 1) this._scatterFarms(town, baseR, grid, rng, placed, buildings);
    town.buildings = buildings;
  }

  /*
   * Направления главных улиц. Стараемся использовать углы входящих трасс
   * (town.incoming), убирая почти совпадающие (улица — это прямая через центр,
   * угол a и a+π — одна и та же улица). Недостающие добираем «веером».
   */
  _mainDirections(town, count, rng) {
    const dirs = [];
    const addUnique = (a) => {
      for (const d of dirs) {
        let diff = Math.abs(((a - d) % Math.PI + Math.PI) % Math.PI);
        if (diff > Math.PI / 2) diff = Math.PI - diff;
        if (diff < 0.35) return; // слишком близко к уже имеющейся улице
      }
      dirs.push(a);
    };

    if (town.incoming && town.incoming.length) {
      for (const a of town.incoming) addUnique(a);
    }
    let guard = 0;
    while (dirs.length < Math.max(1, count) && guard < 12) {
      guard++;
      const base = dirs.length ? dirs[0] : rng() * Math.PI * 2;
      addUnique(base + Math.PI / 2 + (rng() - 0.5) * 0.7);
    }
    return dirs;
  }

  /*
   * Главная улица: полилиния от одного края города через центр к другому,
   * с плавным изгибом (параболой), чтобы улица не была идеально прямой.
   */
  _mainRoad(town, angle, length, rng) {
    const ca = Math.cos(angle);
    const sa = Math.sin(angle);
    const px = -sa; // нормаль (вбок)
    const py = ca;
    const bend = (rng() - 0.5) * length * 0.4;
    const pts = [];
    const steps = 12;
    for (let i = 0; i <= steps; i++) {
      const t = (i / steps) * 2 - 1;       // от -1 до 1
      const along = t * length;
      const curve = (1 - t * t) * bend;    // 0 на концах, максимум в центре
      pts.push([town.x + along * ca + curve * px, town.y + along * sa + curve * py]);
    }
    return pts;
  }

  /*
   * Квартальная сетка в центре крупного города: несколько улиц параллельно
   * главной и столько же поперёк. Даёт узнаваемый «городской» центр.
   */
  _addGrid(roads, town, baseR, angle, rng) {
    const inner = baseR * 0.55;
    const ca = Math.cos(angle);
    const sa = Math.sin(angle);
    const px = -sa;
    const py = ca;
    const lines = 2 + Math.floor(rng() * 2);
    for (let s = -lines; s <= lines; s++) {
      if (s === 0) continue;
      const off = (s / lines) * inner;
      // улица параллельно главной
      roads.push([
        [town.x - ca * inner + px * off, town.y - sa * inner + py * off],
        [town.x + ca * inner + px * off, town.y + sa * inner + py * off],
      ]);
      // поперечная улица
      roads.push([
        [town.x - px * inner + ca * off, town.y - py * inner + sa * off],
        [town.x + px * inner + ca * off, town.y + py * inner + sa * off],
      ]);
    }
  }

  /* Кольцевая дорога вокруг центра (слегка неровная окружность). */
  _addRing(roads, town, r, rng) {
    const pts = [];
    const seg = 16;
    const jitter = r * 0.12;
    for (let i = 0; i <= seg; i++) {
      const a = (i / seg) * Math.PI * 2;
      const rr = r + (rng() - 0.5) * jitter;
      pts.push([town.x + Math.cos(a) * rr, town.y + Math.sin(a) * rr]);
    }
    roads.push(pts);
  }

  /*
   * Второстепенная улица: ответвляется от случайной точки одной из главных
   * дорог и уходит наружу (к окраине) под случайным углом, с лёгким изгибом.
   */
  _addBranch(roads, town, baseR, rng) {
    const base = roads[Math.floor(rng() * Math.min(roads.length, 2))];
    if (!base || base.length < 3) return;
    const p = base[1 + Math.floor(rng() * (base.length - 2))];

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
   * Расставляет здания вдоль одной улицы (с обеих сторон).
   * Дома «смотрят» на улицу: ширина вдоль дороги, глубина — в сторону.
   * Плотность падает к окраине и масштабируется видом пункта (def.density),
   * доля гражданских/промышленных зданий тоже зависит от вида.
   */
  _placeAlongRoad(road, town, baseR, grid, rng, indDir, placed, buildings, def) {
    const step = 1.3;
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
        if (dRatio > 1.05) continue;

        const density = (0.92 - dRatio * 0.5) * def.density;

        for (const side of [-1, 1]) {
          if (rng() > density) continue; // разрыв в застройке

          const angToCenter = Math.atan2(py - town.y, px - town.x);
          const industrial =
            def.industrial > 0 &&
            dRatio > 0.5 &&
            Math.abs(this._angDiff(angToCenter, indDir)) < 0.6 &&
            rng() < def.industrial * 2;

          let kind, w, h, setback;
          if (industrial) {
            kind = "industrial";
            w = 2.2 + rng() * 1.8; // крупные корпуса
            h = 1.6 + rng() * 1.2;
            setback = 1.7;
          } else if (dRatio < 0.34 && rng() < def.civic) {
            kind = "civic";
            w = 1.5 + rng() * 1.0; // здания центра покрупнее
            h = 1.3 + rng() * 0.8;
            setback = 1.1;
          } else {
            kind = "house";
            w = 0.85 + rng() * 0.8; // обычные дома — мелкие
            h = 0.8 + rng() * 0.6;
            setback = 0.9;
          }

          const off = setback + h / 2; // отступ от оси улицы вбок
          const bx = px + nx * side * off;
          const by = py + ny * side * off;

          // Не застраиваем центральную площадь — она остаётся открытой.
          if (town.squareR) {
            const sdx = bx - town.x;
            const sdy = by - town.y;
            if (sdx * sdx + sdy * sdy < town.squareR * town.squareR) continue;
          }

          if (this._isBlocked(grid, bx, by)) continue;
          if (this._tooClose(placed, bx, by, Math.max(w, h) * 0.7)) continue;

          placed.push([bx, by]);
          buildings.push({
            x: bx,
            y: by,
            w,
            h,
            angle: roadAngle + (rng() - 0.5) * 0.12, // лёгкий разнобой
            kind,
            tone: rng(),
          });
        }
      }
    }
  }

  /* Отдельные дворы/хутора на окраине деревень и сёл (вне улиц). */
  _scatterFarms(town, baseR, grid, rng, placed, buildings) {
    const n = 2 + Math.floor(rng() * 3);
    for (let i = 0; i < n; i++) {
      const a = rng() * Math.PI * 2;
      const r = baseR * (0.7 + rng() * 0.45);
      const bx = town.x + Math.cos(a) * r;
      const by = town.y + Math.sin(a) * r;
      if (this._isBlocked(grid, bx, by)) continue;
      if (this._tooClose(placed, bx, by, 1.6)) continue;
      placed.push([bx, by]);
      buildings.push({
        x: bx,
        y: by,
        w: 0.9 + rng() * 0.6,
        h: 0.8 + rng() * 0.5,
        angle: rng() * Math.PI,
        kind: "house",
        tone: rng(),
      });
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

  /*
   * Можно ли застраивать клетку под точкой?
   * Нельзя на воде, на крутом склоне и за пределами карты — так город
   * естественно «обтекает» реки, озёра и горы.
   */
  _isBlocked(grid, wx, wy) {
    const x = Math.round(wx);
    const y = Math.round(wy);
    if (x < 0 || y < 0 || x >= grid.size || y >= grid.size) return true;
    const i = y * grid.size + x;
    if (grid.type[i] === TERRAIN.WATER) return true;
    if (grid.slope && grid.slope[i] > 0.06) return true; // слишком круто для застройки
    return false;
  }
}
