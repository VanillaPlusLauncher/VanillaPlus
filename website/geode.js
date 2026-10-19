/* The launcher's start screen in miniature: a piece of an amethyst geode turning slowly in the air —
   amethyst and budding amethyst on top, calcite and smooth basalt below — with crystals growing on
   the budding blocks stage by stage and sparkles around it. All textures are drawn here (the site
   carries no files from the game). Same build as the launcher's components/splash.js. */
(function () {
  'use strict';

  var SIDE = 3;
  var LAYERS = 3;
  var CELL = 26;
  var LAYER_BLOCKS = ['amethyst_block', 'calcite', 'smooth_basalt'];
  var BUDDING = [0, 4, 8];
  var STAGES = 4;
  var STAGE_MS = 650;
  var CLUSTER_MS = 1500;
  var SHADE = { top: 1.08, south: 0.82, east: 0.92, north: 0.66, west: 0.74 };
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

  function face(texture, side, transform) {
    var element = document.createElement('span');
    element.className = 'geode__face';
    element.style.transform = transform;
    element.style.backgroundImage = 'url("' + texture + '")';
    element.style.setProperty('--shade', String(SHADE[side]));
    return element;
  }

  function start(row) {
    if (!row) return;
    var textures = {
      amethyst_block: mottled(AMETHYST, 11, AMETHYST_LIGHT),
      budding_amethyst: mottled(AMETHYST, 23, AMETHYST_LIGHT, '#26144f'),
      calcite: mottled(['#bdbeb9', '#cacbc6', '#d6d7d2', '#e2e3de', '#eeeeea'], 5),
      smooth_basalt: mottled(['#2f2f35', '#38383f', '#424249', '#4c4c54', '#56565e'], 7),
    };
    var crystals = [0, 1, 2, 3].map(crystal);
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

    for (var layer = 0; layer < LAYERS; layer += 1) {
      var z = LAYERS - 1 - layer;
      for (var y = 0; y < SIDE; y += 1) {
        for (var x = 0; x < SIDE; x += 1) {
          var block = textures[layer === 0 && BUDDING.indexOf(y * SIDE + x) >= 0 ? 'budding_amethyst' : LAYER_BLOCKS[layer]];
          if (layer === 0) slab.appendChild(face(block, 'top', 'translate3d(' + x * c + 'px,' + y * c + 'px,' + (z + 1) * c + 'px)'));
          if (y === SIDE - 1) slab.appendChild(face(block, 'south', 'translate3d(' + x * c + 'px,' + (y + 1) * c + 'px,' + (z + 1) * c + 'px) rotateX(-90deg)'));
          if (y === 0) slab.appendChild(face(block, 'north', 'translate3d(' + (x + 1) * c + 'px,' + y * c + 'px,' + (z + 1) * c + 'px) rotateZ(180deg) rotateX(-90deg)'));
          if (x === SIDE - 1) slab.appendChild(face(block, 'east', 'translate3d(' + (x + 1) * c + 'px,' + (y + 1) * c + 'px,' + (z + 1) * c + 'px) rotateZ(-90deg) rotateX(-90deg)'));
          if (x === 0) slab.appendChild(face(block, 'west', 'translate3d(' + x * c + 'px,' + y * c + 'px,' + (z + 1) * c + 'px) rotateZ(90deg) rotateX(-90deg)'));
        }
      }
    }

    var growers = BUDDING.map(function (place) {
      var holder = document.createElement('span');
      holder.className = 'geode__crystal';
      holder.style.transform = 'translate3d(' + ((place % SIDE) * c + c / 2) + 'px,' + (Math.floor(place / SIDE) * c + c / 2) + 'px,' + LAYERS * c + 'px)';
      var grow = document.createElement('span');
      grow.className = 'geode__grow';
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
    });

    float.appendChild(slab);
    row.appendChild(shadow);
    row.appendChild(float);

    var calm = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    growers.forEach(function (parts, index) {
      if (calm) {
        parts.sprites.forEach(function (sprite) { sprite.style.backgroundImage = 'url("' + crystals[3] + '")'; });
        return;
      }
      var stage = -1;
      function step() {
        stage += 1;
        if (stage < STAGES) {
          parts.sprites.forEach(function (sprite) { sprite.style.backgroundImage = 'url("' + crystals[stage] + '")'; });
          parts.grow.classList.remove('geode__grow--gone', 'geode__grow--pop');
          void parts.grow.offsetWidth;
          parts.grow.classList.add('geode__grow--pop');
          setTimeout(step, stage === STAGES - 1 ? CLUSTER_MS : STAGE_MS);
        } else {
          parts.grow.classList.add('geode__grow--gone');
          stage = -1;
          setTimeout(step, 520);
        }
      }
      setTimeout(step, index * 900);
    });
    if (calm) return;

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
