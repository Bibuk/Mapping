/*
 * renderer.js — отрисовка модели карты на холсте (canvas).
 *
 * Принимает готовую модель из generator.js и рисует топографическую карту
 * в стиле военных карт (как в ARMA): заливка местности, горизонтали высот,
 * дороги, сетка координат и города.
 *
 * Порядок отрисовки (слоями, снизу вверх):
 *   1. Заливка местности (вода, поля, лес...)
 *   2. Горизонтали (изолинии высот)
 *   3. Дороги
 *   4. Сетка координат
 *   5. Города и подписи
 */

// Цветовая палитра в духе топографических карт.
const COLORS = {
  [TERRAIN.WATER]: "#9ec9e8",
  [TERRAIN.SAND]: "#e7dab4",
  [TERRAIN.FIELD]: "#fbf8e3",
  [TERRAIN.FOREST]: "#bcd9a0",
  [TERRAIN.HILL]: "#efe9cf",
  CONTOUR: "#bb8a5e",        // тонкие горизонтали (коричневые)
  CONTOUR_INDEX: "#9c6b3f",  // утолщённые (каждая пятая)
  ROAD: "#d8674a",           // дороги
  ROAD_CASING: "#ffffff",    // светлая обводка дорог
  GRID: "rgba(60, 70, 90, 0.35)",
  GRID_TEXT: "#3a4256",
  // Застройка городов
  BUILTUP: "#ece0cf",        // лёгкая заливка пятна застройки
  STREET: "#cfc8b8",         // улицы внутри города
  SQUARE: "#f4eede",         // центральная площадь
  HOUSE: "#4d4d4d",          // жилые дома
  CIVIC: "#5a4c3f",          // гражданские здания (центр)
  INDUSTRIAL: "#737373",     // промзона
  BUILDING_EDGE: "rgba(0,0,0,0.35)",
  TOWN_TEXT: "#1a1a1a",
  TOWN_HALO: "#ffffff",
};

class MapRenderer {
  /** @param {HTMLCanvasElement} canvas */
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
  }

  /*
   * Главный метод отрисовки.
   * map     — модель из MapGenerator.generate()
   * options — что показывать: { showGrid, showContours, showLabels }
   */
  render(map, options) {
    const ctx = this.ctx;
    const W = this.canvas.width;
    const H = this.canvas.height;

    // во сколько пикселей превращается одна клетка сетки
    this.scale = W / map.size;

    ctx.clearRect(0, 0, W, H);

    this._drawTerrain(map);
    if (options.showContours) this._drawContours(map);
    this._drawRoads(map);
    if (options.showGrid) this._drawGrid(map);
    this._drawTowns(map, options.showLabels);
    this._drawBorder();
  }

  /* 1. Заливка местности — каждая клетка закрашивается своим цветом. */
  _drawTerrain(map) {
    const ctx = this.ctx;
    const s = this.scale;
    const size = map.size;

    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const t = map.type[y * size + x];
        ctx.fillStyle = COLORS[t];
        // +1 к размеру, чтобы между клетками не было щелей
        ctx.fillRect(x * s, y * s, s + 1, s + 1);
      }
    }
  }

  /*
   * 2. Горизонтали (изолинии) — линии равной высоты.
   * Используется классический алгоритм «марширующих квадратов»
   * (marching squares): для каждой ячейки из 4 высот соседних точек
   * определяем, где линия заданной высоты пересекает её рёбра, и рисуем отрезок.
   */
  _drawContours(map) {
    const ctx = this.ctx;
    const size = map.size;
    const h = map.height;

    // Рисуем горизонтали только над уровнем воды, через равные интервалы.
    const interval = 0.06;
    let levelIndex = 0;

    for (let iso = map.seaLevel + interval; iso < 1; iso += interval) {
      // каждая пятая линия — «утолщённая» (index contour), как на настоящих картах
      const isIndex = levelIndex % 5 === 0;
      ctx.strokeStyle = isIndex ? COLORS.CONTOUR_INDEX : COLORS.CONTOUR;
      ctx.lineWidth = isIndex ? 1.4 : 0.7;
      ctx.beginPath();

      for (let y = 0; y < size - 1; y++) {
        for (let x = 0; x < size - 1; x++) {
          this._marchingSquareCell(ctx, h, size, x, y, iso);
        }
      }

      ctx.stroke();
      levelIndex++;
    }
  }

  /*
   * Обработка одной ячейки для «марширующих квадратов».
   * Углы ячейки: a=верх-лево, b=верх-право, c=низ-право, d=низ-лево.
   * По тому, какие углы выше уровня iso, выбираем, через какие рёбра
   * проходит изолиния, и добавляем отрезок в текущий путь.
   */
  _marchingSquareCell(ctx, h, size, x, y, iso) {
    const s = this.scale;
    const a = h[y * size + x];
    const b = h[y * size + x + 1];
    const c = h[(y + 1) * size + x + 1];
    const d = h[(y + 1) * size + x];

    // 4-битный код ситуации: какой угол выше уровня
    let code = 0;
    if (a > iso) code |= 1;
    if (b > iso) code |= 2;
    if (c > iso) code |= 4;
    if (d > iso) code |= 8;

    if (code === 0 || code === 15) return; // линия не проходит через ячейку

    const x0 = x * s;
    const y0 = y * s;

    // Точки пересечения на рёбрах (линейная интерполяция для гладкости).
    const top = () => [x0 + s * (iso - a) / (b - a), y0];
    const right = () => [x0 + s, y0 + s * (iso - b) / (c - b)];
    const bottom = () => [x0 + s * (iso - d) / (c - d), y0 + s];
    const left = () => [x0, y0 + s * (iso - a) / (d - a)];

    // Для каждого кода — какие рёбра соединить отрезком.
    const seg = (p, q) => {
      ctx.moveTo(p[0], p[1]);
      ctx.lineTo(q[0], q[1]);
    };

    switch (code) {
      case 1: case 14: seg(left(), top()); break;
      case 2: case 13: seg(top(), right()); break;
      case 3: case 12: seg(left(), right()); break;
      case 4: case 11: seg(right(), bottom()); break;
      case 6: case 9: seg(top(), bottom()); break;
      case 7: case 8: seg(left(), bottom()); break;
      // «сёдла» — неоднозначные случаи, рисуем обе линии
      case 5: seg(left(), top()); seg(right(), bottom()); break;
      case 10: seg(top(), right()); seg(left(), bottom()); break;
    }
  }

  /* 3. Дороги — линии между городами, со светлой обводкой для контраста. */
  _drawRoads(map) {
    const ctx = this.ctx;
    const s = this.scale;
    if (map.roads.length === 0) return;

    const drawPass = (color, width) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.beginPath();
      for (const road of map.roads) {
        const a = map.towns[road.from];
        const b = map.towns[road.to];
        ctx.moveTo(a.x * s, a.y * s);
        ctx.lineTo(b.x * s, b.y * s);
      }
      ctx.stroke();
    };

    // сначала широкая белая «подложка», затем сама дорога — даёт аккуратный вид
    drawPass(COLORS.ROAD_CASING, 5);
    drawPass(COLORS.ROAD, 2.5);
  }

  /*
   * 4. Сетка координат с подписями по краям.
   * Делим карту на квадраты и нумеруем столбцы (восток) и строки (север),
   * как принято на военных картах.
   */
  _drawGrid(map) {
    const ctx = this.ctx;
    const W = this.canvas.width;
    const H = this.canvas.height;

    // число делений сетки зависит от размера карты (примерно квадрат на ~километр)
    const divisions = Math.max(5, Math.round(map.size / 32));
    const step = W / divisions;

    ctx.strokeStyle = COLORS.GRID;
    ctx.lineWidth = 1;
    ctx.fillStyle = COLORS.GRID_TEXT;
    ctx.font = "11px 'Segoe UI', sans-serif";
    ctx.textBaseline = "top";

    for (let i = 0; i <= divisions; i++) {
      const p = i * step;

      // вертикальные линии
      ctx.beginPath();
      ctx.moveTo(p, 0);
      ctx.lineTo(p, H);
      ctx.stroke();

      // горизонтальные линии
      ctx.beginPath();
      ctx.moveTo(0, p);
      ctx.lineTo(W, p);
      ctx.stroke();

      // подписи (двузначные номера: 01, 02, ...)
      if (i < divisions) {
        const label = String(i + 1).padStart(2, "0");
        ctx.textAlign = "left";
        ctx.fillText(label, p + 3, 3);          // сверху (восток)
        ctx.fillText(label, p + 3, H - 14);     // снизу
        ctx.fillText(label, 3, p + 3);          // слева (север)
      }
    }
  }

  /*
   * 5. Города: детальная застройка — пятно застройки, площадь, улицы, дома.
   * Сначала рисуем все «тела» городов, затем поверх — подписи, чтобы
   * текст не перекрывался зданиями соседнего города.
   */
  _drawTowns(map, showLabels) {
    for (const town of map.towns) {
      this._drawBuiltUp(town);
      this._drawTownSquare(town);
      this._drawTownStreets(town);
      this._drawTownBuildings(town);
    }
    if (showLabels) {
      for (const town of map.towns) this._drawTownLabel(town);
    }
  }

  /* Лёгкая заливка пятна застройки — выделяет город на фоне местности. */
  _drawBuiltUp(town) {
    if (!town.extent) return;
    const ctx = this.ctx;
    const s = this.scale;
    const N = town.extent.length;
    ctx.beginPath();
    for (let i = 0; i <= N; i++) {
      const idx = i % N;
      const ang = (idx / N) * Math.PI * 2;
      const r = town.extent[idx];
      const x = (town.x + Math.cos(ang) * r) * s;
      const y = (town.y + Math.sin(ang) * r) * s;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fillStyle = COLORS.BUILTUP;
    ctx.fill();
  }

  /* Центральная площадь — открытое светлое пятно в центре города. */
  _drawTownSquare(town) {
    if (!town.square) return;
    const ctx = this.ctx;
    const s = this.scale;
    ctx.beginPath();
    ctx.arc(town.x * s, town.y * s, town.square.r * s, 0, Math.PI * 2);
    ctx.fillStyle = COLORS.SQUARE;
    ctx.fill();
  }

  /* Сеть улиц внутри города. */
  _drawTownStreets(town) {
    if (!town.streets || town.streets.length === 0) return;
    const ctx = this.ctx;
    const s = this.scale;
    ctx.strokeStyle = COLORS.STREET;
    ctx.lineWidth = 1.2;
    ctx.lineCap = "round";
    ctx.beginPath();
    for (const [x1, y1, x2, y2] of town.streets) {
      ctx.moveTo(x1 * s, y1 * s);
      ctx.lineTo(x2 * s, y2 * s);
    }
    ctx.stroke();
  }

  /* Здания — повёрнутые прямоугольники, цвет зависит от типа застройки. */
  _drawTownBuildings(town) {
    if (!town.buildings) return;
    const ctx = this.ctx;
    const s = this.scale;
    for (const b of town.buildings) {
      const color =
        b.kind === "industrial" ? COLORS.INDUSTRIAL :
        b.kind === "civic" ? COLORS.CIVIC : COLORS.HOUSE;
      const w = b.w * s;
      const h = b.h * s;

      ctx.save();
      ctx.translate(b.x * s, b.y * s);
      ctx.rotate(b.angle);
      ctx.fillStyle = color;
      ctx.fillRect(-w / 2, -h / 2, w, h);
      // тонкая обводка, чтобы дом читался на светлом фоне
      ctx.lineWidth = 0.4;
      ctx.strokeStyle = COLORS.BUILDING_EDGE;
      ctx.strokeRect(-w / 2, -h / 2, w, h);
      ctx.restore();
    }
  }

  /* Название города — над пятном застройки, с белой обводкой для читаемости. */
  _drawTownLabel(town) {
    const ctx = this.ctx;
    const s = this.scale;
    const cx = town.x * s;
    const cy = town.y * s - (town.radius || 4) * s - 4;

    ctx.font = "bold 12px 'Segoe UI', sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    ctx.lineWidth = 3;
    ctx.strokeStyle = COLORS.TOWN_HALO;
    ctx.strokeText(town.name, cx, cy);
    ctx.fillStyle = COLORS.TOWN_TEXT;
    ctx.fillText(town.name, cx, cy);
  }

  /* Аккуратная рамка вокруг всей карты. */
  _drawBorder() {
    const ctx = this.ctx;
    ctx.strokeStyle = "#3a4256";
    ctx.lineWidth = 2;
    ctx.strokeRect(1, 1, this.canvas.width - 2, this.canvas.height - 2);
  }
}
