/* The launcher's start screen in miniature: a 3×3 plate of budding amethyst, one block thick,
   turning slowly in the air. Crystals grow on it like a snake — from the outer edge round and
   round into the middle, each through small, medium and large bud to a cluster — then shrink
   back stage by stage in the same order and grow again; sparkles blink around it. Same build and
   timings as the launcher's components/splash.js, with the game's own textures from assets/mc/
   (on the site's server only, never in git); without them the textures are drawn here. */
(function () {
  'use strict';

  var SIDE = 3;
  var CELL = 28;
  var STAGES = 4;
  var STAGE_MS = 210; // each growth stage
  var STEP_MS = 260; // the snake's head moves on to the next block
  var HOLD_MS = 1300; // the full plate stays a moment, the crystals shrink back the same way…
  var REST_MS = 450; // …a short rest, and again
  var SHADE = { top: 1.06, south: 0.8, east: 0.9, north: 0.64, west: 0.72 };
  var AMETHYST = ['#3b2470', '#4a2d8a', '#5b39a3', '#6f48bb', '#8459d0', '#9a70de'];
  var AMETHYST_LIGHT = ['#c99cf0', '#e9c6f7', '#ffe3fb'];

  function seeded(seed) {
    var value = seed;
    return function () {
      value = (value * 1103515245 + 12345) & 0x7fffffff;
      return value / 0x7fffffff;
    };
  }

  function canvas16() {
    var canvas = document.createElement('canvas');
    canvas.width = 16;
    canvas.height = 16;
    return canvas;
  }

  /* Mottled texture: soft patches from a coarse grid plus per-pixel grain. */
  function mottled(palette, seed, highlights, cracks) {
    var random = seeded(seed);
    var canvas = canvas16();
    var context = canvas.getContext('2d');
    var coarse = [];
    for (var i = 0; i < 25; i += 1) coarse.push(random());
    function v(x, y) { return coarse[Math.min(4, y) * 5 + Math.min(4, x)]; }
    for (var y = 0; y < 16; y += 1) {
      for (var x = 0; x < 16; x += 1) {
        var gx = x / 4, gy = y / 4, x0 = Math.floor(gx), y0 = Math.floor(gy), fx = gx - x0, fy = gy - y0;
        var smooth = v(x0, y0) * (1 - fx) * (1 - fy) + v(x0 + 1, y0) * fx * (1 - fy) + v(x0, y0 + 1) * (1 - fx) * fy + v(x0 + 1, y0 + 1) * fx * fy;
        var value = Math.min(0.999, Math.max(0, smooth * 0.75 + random() * 0.4 - 0.08));
        context.fillStyle = palette[Math.floor(value * palette.length)];
        context.fillRect(x, y, 1, 1);
      }
    }
    if (highlights) {
      for (var index = 0; index < 7; index += 1) {
        var hx = Math.floor(random() * 15), hy = Math.floor(random() * 15);
        context.fillStyle = highlights[index % highlights.length];
        context.fillRect(hx, hy, 1 + Math.round(random()), 1);
        context.fillStyle = highlights[(index + 1) % highlights.length];
        context.fillRect(hx, hy + 1, 1, 1);
      }
    }
    if (cracks) {
      context.fillStyle = cracks;
      [[2, 3, 3, 1], [4, 3, 1, 2], [10, 2, 1, 3], [9, 4, 3, 1], [6, 10, 1, 3], [6, 12, 3, 1], [12, 11, 2, 1], [13, 9, 1, 3]].forEach(function (r) {
        context.fillRect(r[0], r[1], r[2], r[3]);
      });
    }
    return canvas.toDataURL();
  }

  /* A crystal of the given stage (0 small bud … 3 cluster): violet spikes with light tips. */
  function crystal(stage) {
    var random = seeded(3 + stage * 17);
    var canvas = canvas16();
    var context = canvas.getContext('2d');
    var height = [5, 8, 11, 14][stage];
    var spikes = stage === 3 ? [[3, 9], [7, 14], [11, 10], [5, 6], [10, 6]] : [[7, height]];
    if (stage === 2) spikes.push([4, 7], [10, 8]);
    if (stage === 1) spikes.push([10, 5]);
    spikes.forEach(function (spike) {
      for (var y = 0; y < spike[1]; y += 1) {
        var tip = y > spike[1] - 3;
        context.fillStyle = tip ? '#f3d6ff' : random() < 0.3 ? '#b78cf0' : y % 3 === 0 ? '#6c44c4' : '#8a5ddc';
        context.fillRect(spike[0], 15 - y, tip ? 1 : 2, 1);
      }
    });
    return canvas.toDataURL();
  }

  /* The blocks of an n × n plate from its outer edge round and round into the middle (clockwise). */
  function spiralOrder(n) {
    var order = [];
    var left = 0, top = 0, right = n - 1, bottom = n - 1, x, y;
    while (left <= right && top <= bottom) {
      for (x = left; x <= right; x += 1) order.push([x, top]);
      for (y = top + 1; y <= bottom; y += 1) order.push([right, y]);
      if (top < bottom) for (x = right - 1; x >= left; x -= 1) order.push([x, bottom]);
      if (left < right) for (y = bottom - 1; y > top; y -= 1) order.push([left, y]);
      left += 1; top += 1; right -= 1; bottom -= 1;
    }
    return order;
  }

  function face(texture, side, transform) {
    var element = document.createElement('span');
    element.className = 'geode__face';
    element.style.transform = transform;
    element.style.backgroundImage = 'url("' + texture + '")';
    element.style.setProperty('--shade', String(SHADE[side]));
    return element;
  }

  /* A crystal standing on a block: two crossed pictures, like buds in the game; turned a little each. */
  function buildCrystal(slab, place, turn) {
    var c = CELL;
    var holder = document.createElement('span');
    holder.className = 'geode__crystal';
    holder.style.transform = 'translate3d(' + (place[0] * c + c / 2) + 'px,' + (place[1] * c + c / 2) + 'px,' + c + 'px) rotateZ(' + turn + 'deg)';
    var grow = document.createElement('span');
    grow.className = 'geode__grow geode__grow--gone';
    var sprites = [45, -45].map(function (angle) {
      var sprite = document.createElement('span');
      sprite.className = 'geode__sprite';
      sprite.style.transform = 'rotateZ(' + angle + 'deg) rotateX(-90deg)';
      grow.appendChild(sprite);
      return sprite;
    });
    holder.appendChild(grow);
    slab.appendChild(holder);
    return { grow: grow, sprites: sprites };
  }

  function showStage(parts, picture) {
    parts.sprites.forEach(function (sprite) { sprite.style.backgroundImage = 'url("' + picture + '")'; });
  }

  /* One crystal through its stages — small bud to cluster, or (shrinking) cluster back to small
     bud and gone — with a little pop at each. */
  function stepCrystal(parts, pictures, shrinking) {
    var stages = shrinking ? [3, 2, 1, 0, -1] : [0, 1, 2, 3];
    var index = 0;
    (function step() {
      var stage = stages[index];
      parts.grow.classList.remove('geode__grow--pop');
      if (stage < 0) {
        parts.grow.classList.add('geode__grow--gone');
        return;
      }
      showStage(parts, pictures[stage]);
      parts.grow.classList.remove('geode__grow--gone');
      void parts.grow.offsetWidth; // restart the pop of a new stage
      parts.grow.classList.add('geode__grow--pop');
      index += 1;
      if (index < stages.length) setTimeout(step, STAGE_MS);
    })();
  }

  /* The snake: crystals grow block after block into the middle, then shrink back stage by stage
     in the same order (the edge first, the middle last), a short rest, again. */
  function snakeLoop(crystals, pictures) {
    var lastStarts = (crystals.length - 1) * STEP_MS;
    (function cycle() {
      crystals.forEach(function (parts, index) {
        setTimeout(function () { stepCrystal(parts, pictures, false); }, index * STEP_MS);
      });
      var grown = lastStarts + STAGES * STAGE_MS;
      setTimeout(function () {
        crystals.forEach(function (parts, index) {
          setTimeout(function () { stepCrystal(parts, pictures, true); }, index * STEP_MS);
        });
        setTimeout(cycle, lastStarts + STAGES * STAGE_MS + REST_MS);
      }, grown + HOLD_MS);
    })();
  }

  /* The game's own textures, put on the site's server by hand (assets/mc/, never in git). When any
     of them is missing — a copy of the site without them — the drawn stand-ins are used. */
  var GAME_TEXTURES = 'assets/mc/';
  var BLOCKS = ['amethyst_block', 'budding_amethyst'];
  var STAGE_NAMES = ['small_amethyst_bud', 'medium_amethyst_bud', 'large_amethyst_bud', 'amethyst_cluster'];

  function loadGameTextures(done) {
    var names = BLOCKS.concat(STAGE_NAMES);
    var left = names.length;
    var failed = false;
    var finished = false;
    function finish() {
      if (finished) return;
      finished = true;
      if (failed) { done(null); return; }
      var textures = {};
      BLOCKS.forEach(function (name) { textures[name] = GAME_TEXTURES + name + '.png'; });
      done({ textures: textures, pictures: STAGE_NAMES.map(function (name) { return GAME_TEXTURES + name + '.png'; }) });
    }
    names.forEach(function (name) {
      var image = new Image();
      image.onload = function () { left -= 1; if (!left) finish(); };
      image.onerror = function () { failed = true; finish(); };
      image.src = GAME_TEXTURES + name + '.png';
    });
    setTimeout(function () { failed = failed || left > 0; finish(); }, 3000);
  }

  function start(row) {
    if (!row) return;
    loadGameTextures(function (game) {
      if (game) { build(row, game.textures, game.pictures); return; }
      build(row, {
        amethyst_block: mottled(AMETHYST, 11, AMETHYST_LIGHT),
        budding_amethyst: mottled(AMETHYST, 23, AMETHYST_LIGHT, '#26144f')
      }, [0, 1, 2, 3].map(crystal));
    });
  }

  function build(row, textures, pictures) {
    var c = CELL;

    var float = document.createElement('div');
    float.className = 'geode__float';
    var shadow = document.createElement('div');
    shadow.className = 'geode__shadow';
    var slab = document.createElement('div');
    slab.className = 'geode__slab';
    slab.style.setProperty('--cell', c + 'px');
    slab.style.width = SIDE * c + 'px';
    slab.style.height = SIDE * c + 'px';

    // The faces that can be seen: the tops (budding amethyst) and the sides along the edge (amethyst
    // block), in a plane where x goes right, y towards the viewer and z up.
    var top = textures.budding_amethyst, edge = textures.amethyst_block;
    for (var y = 0; y < SIDE; y += 1) {
      for (var x = 0; x < SIDE; x += 1) {
        slab.appendChild(face(top, 'top', 'translate3d(' + x * c + 'px,' + y * c + 'px,' + c + 'px)'));
        if (y === SIDE - 1) slab.appendChild(face(edge, 'south', 'translate3d(' + x * c + 'px,' + (y + 1) * c + 'px,' + c + 'px) rotateX(-90deg)'));
        if (y === 0) slab.appendChild(face(edge, 'north', 'translate3d(' + (x + 1) * c + 'px,' + y * c + 'px,' + c + 'px) rotateZ(180deg) rotateX(-90deg)'));
        if (x === SIDE - 1) slab.appendChild(face(edge, 'east', 'translate3d(' + (x + 1) * c + 'px,' + (y + 1) * c + 'px,' + c + 'px) rotateZ(-90deg) rotateX(-90deg)'));
        if (x === 0) slab.appendChild(face(edge, 'west', 'translate3d(' + x * c + 'px,' + y * c + 'px,' + c + 'px) rotateZ(90deg) rotateX(-90deg)'));
      }
    }

    var random = seeded(7);
    var crystals = spiralOrder(SIDE).map(function (place) {
      return buildCrystal(slab, place, Math.round((random() - 0.5) * 40));
    });

    float.appendChild(slab);
    row.appendChild(shadow);
    row.appendChild(float);

    // Calm mode: the plate stands full-grown, without the snake and the sparkles.
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      crystals.forEach(function (parts) {
        showStage(parts, pictures[STAGES - 1]);
        parts.grow.classList.remove('geode__grow--gone');
      });
      return;
    }
    snakeLoop(crystals, pictures);

    (function spark() {
      var element = document.createElement('span');
      element.className = 'geode__spark';
      element.style.left = 18 + Math.random() * 64 + '%';
      element.style.top = 8 + Math.random() * 58 + '%';
      element.style.setProperty('--size', 2 + Math.round(Math.random()) + 'px');
      element.addEventListener('animationend', function () { element.remove(); });
      row.appendChild(element);
      setTimeout(spark, 160 + Math.random() * 260);
    })();
  }

  window.AmethyxGeode = { start: start };
})();
