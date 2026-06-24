/*
 * town.js — детальная процедурная застройка города.
 *
 * Превращает «точку города» в настоящий населённый пункт:
 *   - неровное пятно застройки (контур города),
 *   - сеть улиц (повёрнутая сетка кварталов),
 *   - здания-прямоугольники вдоль улиц,
 *   - типы застройки: центр (гражданские здания), жилые дома, промзона,
 *   - центральная площадь.
 *
 * Всё детерминировано: для одного и того же города (его координат и сида)
 * всегда получается одинаковая застройка.
 *
 * Координаты застройки — в тех же «клетках» сетки, что и вся карта,
 * поэтому renderer масштабирует их так же, как остальные объекты.
 */

class TownBuilder {
  /** @param {number} seed — общий сид карты */
  constructor(seed) {
    this.seed = seed >>> 0;
  }

  /*
   * Детерминированный генератор случайных чисел для конкретного города.
   * Зерно складывается из сида карты и координат города — поэтому каждый
   * город застраивается «по-своему», но воспроизводимо.
   */
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
   * Главный метод: достраивает объект town полями
   *   angle, radius, extent, square, streets, buildings.
   * grid — { type, size } для проверки, что не строим на воде.
   */
  build(town, grid) {
    const rng = this._rng(town.x, town.y);

    // Базовый радиус города зависит от его «размера» (0.5..1.0).
    const baseR = 4 + town.size * 8;
    town.radius = baseR;
    // Главная ориентация города — под этим углом ляжет сетка улиц.
    town.angle = rng() * Math.PI;

    // --- Неровный контур застройки ---
    // 16 радиусов по кругу со случайным разбросом, слегка сглаженных,
    // дают «органичную» границу города вместо идеального круга.
    const N = 16;
    const raw = [];
    for (let i = 0; i < N; i++) raw.push(baseR * (0.7 + rng() * 0.45));
    const ext = raw.map((v, i) => (raw[(i + N - 1) % N] + v * 2 + raw[(i + 1) % N]) / 4);
    town.extent = ext;

    // Функция «точка (dx,dy) от центра — внутри города?»
    const inside = (dx, dy) => {
      const d = Math.hypot(dx, dy);
      let ang = Math.atan2(dy, dx);
      if (ang < 0) ang += Math.PI * 2;
      const f = (ang / (Math.PI * 2)) * N;
      const i0 = Math.floor(f) % N;
      const i1 = (i0 + 1) % N;
      const r = ext[i0] + (ext[i1] - ext[i0]) * (f - Math.floor(f));
      return d <= r;
    };

    // Центральная площадь — только у достаточно крупных городов.
    town.square = town.size > 0.6 ? { r: baseR * 0.16 } : null;
    const sqR = town.square ? town.square.r : 0;

    // --- Сеть улиц: повёрнутая сетка, обрезанная по контуру города ---
    const block = 3.0; // расстояние между улицами (размер квартала), в клетках
    const ca = Math.cos(town.angle);
    const sa = Math.sin(town.angle);
    const R = baseR * 1.3; // запас за контур, лишнее обрежется
    const streets = [];
    for (let off = -R; off <= R; off += block) {
      // продольные улицы (вдоль главной оси)
      this._clipLine(streets, town, ca, sa, -sa, ca, off, R, inside);
      // поперечные улицы
      this._clipLine(streets, town, -sa, ca, ca, sa, off, R, inside);
    }
    town.streets = streets;

    // Направление промзоны — один сектор на окраине города.
    const indDir = rng() * Math.PI * 2;

    // --- Здания по кварталам ---
    const buildings = [];
    const half = block / 2;
    for (let u = -R; u <= R; u += block) {
      for (let v = -R; v <= R; v += block) {
        // центр квартала в мировых координатах (клетки)
        const lu = u + half;
        const lv = v + half;
        const wx = town.x + lu * ca + lv * -sa;
        const wy = town.y + lu * sa + lv * ca;
        const dx = wx - town.x;
        const dy = wy - town.y;
        const dist = Math.hypot(dx, dy);

        if (!inside(dx, dy)) continue;            // за контуром города
        if (dist < sqR) continue;                 // площадь оставляем открытой
        if (this._isWater(grid, wx, wy)) continue; // не строим на воде
        if (rng() < 0.18) continue;               // случайные пустыри/сады

        // Зонирование по удалённости от центра + сектор промзоны.
        const dRatio = dist / baseR;
        const angDiff = Math.abs(
          ((Math.atan2(dy, dx) - indDir + Math.PI * 3) % (Math.PI * 2)) - Math.PI
        );
        let kind;
        if (dRatio > 0.55 && angDiff < 0.6) kind = "industrial"; // окраина, сектор
        else if (dRatio < 0.32) kind = "civic";                  // центр
        else kind = "house";                                     // жилая зона

        this._fillBlock(buildings, wx, wy, town.angle, block, kind, rng);
      }
    }
    town.buildings = buildings;
  }

  /*
   * Заполняет один квартал зданиями нужного типа.
   * Здание — { x, y, w, h, angle, kind } в координатах-клетках.
   */
  _fillBlock(out, wx, wy, angle, block, kind, rng) {
    const ca = Math.cos(angle);
    const sa = Math.sin(angle);

    // помещает одно здание со смещением (offU, offV) в локальной системе квартала
    const place = (offU, offV, w, h) => {
      const ju = (rng() - 0.5) * 0.3;
      const jv = (rng() - 0.5) * 0.3;
      const x = wx + (offU + ju) * ca + (offV + jv) * -sa;
      const y = wy + (offU + ju) * sa + (offV + jv) * ca;
      out.push({ x, y, w, h, angle: angle + (rng() - 0.5) * 0.1, kind });
    };

    if (kind === "industrial") {
      place(0, 0, block * 0.8, block * 0.55); // один крупный корпус
    } else if (kind === "civic") {
      place(0, 0, block * 0.6, block * 0.6);  // одно здание покрупнее
    } else {
      // жилая застройка: до четырёх небольших домов в квартале
      const s = block * 0.27;
      const d = block * 0.26;
      for (const ou of [-d, d]) {
        for (const ov of [-d, d]) {
          if (rng() < 0.15) continue; // часть участков пустые
          place(ou, ov, s, s * (0.8 + rng() * 0.5));
        }
      }
    }
  }

  /*
   * Берёт прямую линию (точка центра города + смещение off вдоль оси A,
   * и движение t вдоль оси B) и оставляет только её части внутри города.
   * Так улицы получаются обрезанными ровно по контуру застройки.
   */
  _clipLine(out, town, ax, ay, bx, by, off, R, inside) {
    const step = 0.5;
    let start = null;
    let last = null;
    const flush = () => {
      if (start && last && (start[0] !== last[0] || start[1] !== last[1])) {
        out.push([start[0], start[1], last[0], last[1]]);
      }
      start = null;
      last = null;
    };
    for (let t = -R; t <= R + 1e-9; t += step) {
      const wx = town.x + off * ax + t * bx;
      const wy = town.y + off * ay + t * by;
      if (inside(wx - town.x, wy - town.y)) {
        if (!start) start = [wx, wy];
        last = [wx, wy];
      } else {
        flush();
      }
    }
    flush();
  }

  /* Проверка: клетка под точкой — вода? (на воде не строим) */
  _isWater(grid, wx, wy) {
    const x = Math.round(wx);
    const y = Math.round(wy);
    if (x < 0 || y < 0 || x >= grid.size || y >= grid.size) return true;
    return grid.type[y * grid.size + x] === TERRAIN.WATER;
  }
}
