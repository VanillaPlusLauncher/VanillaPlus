/*
 * Gestures of the 3D player, shared by the home screen and the Wardrobe: small functions of time
 * (player, t seconds) => done?, run inside skinview3d's FunctionAnimation, each from the resting
 * pose. Arms never swing into the head: raised arms go out to the side, arms brought to the face
 * stop in front of it (checked side-on: no arm passes through the head).
 */

export const ease = (t) => (t < 0 ? 0 : t > 1 ? 1 : t * t * (3 - 2 * t));
/**
 * Leaning the upper body forward by `amount` (1 = the game's sneak), around the hips: the body tilts
 * and moves, the head, arms and legs follow, so nothing comes apart (skinview3d's crouch offsets).
 */
function lean(player, amount) {
  const { body, head, leftArm, rightArm, leftLeg, rightLeg } = player.skin;
  body.rotation.x = 0.4538 * amount;
  body.position.z += -2.1244 * amount;
  body.position.y += -2.1037 * amount;
  head.position.y += -3.6183 * amount;
  for (const arm of [leftArm, rightArm]) {
    arm.position.z += 0.1683 * amount;
    arm.position.y += -2.5394 * amount;
    arm.rotation.x += 0.4104 * amount;
  }
  leftLeg.position.z += -3.45 * amount;
  rightLeg.position.z += -3.45 * amount;
}

/** 0 → 1 over `rise` s, held, back to 0 over the last `fall` s of `length`. */
const envelope = (t, length, rise = 0.3, fall = 0.3) => ease(t / rise) * (1 - ease((t - (length - fall)) / fall));

export const GESTURES = {
  wave(player, t) {
    const lift = envelope(t, 1.9);
    player.skin.rightArm.rotation.z = -lift * 2.2;
    player.skin.rightArm.rotation.x = Math.sin(t * 11) * 0.2 * lift;
    return t > 1.9;
  },
  /** "Hi, I'm here!": two hops with both arms going up and down. */
  hello(player, t) {
    const hops = Math.min(t / 1.2, 1);
    const hop = Math.abs(Math.sin(hops * Math.PI * 2));
    player.position.y = hop * 2.6;
    const arms = hops < 1 ? 0.5 + 0.5 * Math.sin(hops * Math.PI * 4 - Math.PI / 2) : 0;
    player.skin.leftArm.rotation.z = arms * 2.5;
    player.skin.rightArm.rotation.z = -arms * 2.5;
    player.skin.leftLeg.rotation.z = hop * 0.12;
    player.skin.rightLeg.rotation.z = -hop * 0.12;
    return t > 1.25;
  },
  jump(player, t) {
    const phase = Math.min(t / 0.9, 1);
    player.position.y = Math.sin(phase * Math.PI) * 4;
    const arms = Math.sin(phase * Math.PI);
    player.skin.leftArm.rotation.z = arms * 2.4;
    player.skin.rightArm.rotation.z = -arms * 2.4;
    player.skin.leftLeg.rotation.x = -arms * 0.4;
    player.skin.rightLeg.rotation.x = arms * 0.4;
    return t > 1.1;
  },
  spin(player, t) {
    player.rotation.y = ease(t / 1.2) * Math.PI * 2;
    return t > 1.3;
  },
  nod(player, t) {
    player.skin.head.rotation.x += Math.sin(t * 12) * 0.35 * (1 - ease(t / 1.1));
    return t > 1.1;
  },
  punch(player, t) {
    const hit = Math.sin(Math.min(t / 0.5, 1) * Math.PI);
    player.skin.rightArm.rotation.x = -hit * 1.7;
    player.skin.body.rotation.y = -hit * 0.3;
    return t > 0.7;
  },
  /** The game's sneak: eases down, holds, eases back up. */
  crouch(player, t) {
    lean(player, 0.9 * envelope(t, 1.7, 0.35, 0.45));
    return t > 1.7;
  },
  dance(player, t) {
    const beat = Math.sin(t * 8);
    player.skin.leftArm.rotation.z = 0.4 + Math.max(0, beat) * 1.9;
    player.skin.rightArm.rotation.z = -0.4 - Math.max(0, -beat) * 1.9;
    player.rotation.y = Math.sin(t * 4) * 0.4;
    player.position.y = Math.abs(beat) * 0.8;
    return t > 2.4;
  },
  clap(player, t) {
    const lift = envelope(t, 1.8);
    const hands = Math.abs(Math.sin(t * 11));
    player.skin.leftArm.rotation.x = -1.35 * lift;
    player.skin.rightArm.rotation.x = -1.35 * lift;
    player.skin.leftArm.rotation.z = -(0.15 + hands * 0.3) * lift;
    player.skin.rightArm.rotation.z = (0.15 + hands * 0.3) * lift;
    return t > 1.8;
  },
  stretch(player, t) {
    const up = envelope(t, 2.1, 0.6, 0.5);
    player.skin.leftArm.rotation.z = up * 2.8;
    player.skin.rightArm.rotation.z = -up * 2.8;
    player.skin.head.rotation.x -= up * 0.35;
    player.skin.body.rotation.x = -up * 0.08;
    player.position.y = up * 0.4;
    return t > 2.1;
  },
  shrug(player, t) {
    const up = envelope(t, 1.3);
    player.skin.leftArm.rotation.z = up * 0.55;
    player.skin.rightArm.rotation.z = -up * 0.55;
    player.skin.leftArm.rotation.x = -up * 0.3;
    player.skin.rightArm.rotation.x = -up * 0.3;
    player.skin.head.rotation.z = up * 0.25;
    return t > 1.3;
  },
  lookAround(player, t) {
    const env = envelope(t, 2.7, 0.4, 0.4);
    player.skin.head.rotation.y += Math.sin(t * 2.4) * 0.95 * env;
    player.skin.head.rotation.x += Math.sin(t * 1.3) * 0.15 * env;
    return t > 2.7;
  },
  walk(player, t) {
    const env = envelope(t, 2.5);
    const step = Math.sin(t * 7);
    player.skin.leftLeg.rotation.x = step * 0.6 * env;
    player.skin.rightLeg.rotation.x = -step * 0.6 * env;
    player.skin.leftArm.rotation.x = -step * 0.5 * env;
    player.skin.rightArm.rotation.x = step * 0.5 * env;
    player.position.y = Math.abs(step) * 0.3 * env;
    return t > 2.5;
  },
  /** The hand stops at the brim of the forehead, in front of the head. */
  salute(player, t) {
    const lift = envelope(t, 1.6);
    player.skin.rightArm.rotation.x = -1.95 * lift;
    player.skin.rightArm.rotation.z = -0.6 * lift;
    player.skin.head.rotation.x -= 0.1 * lift;
    return t > 1.6;
  },
  think(player, t) {
    const lift = envelope(t, 2.4, 0.4, 0.4);
    player.skin.rightArm.rotation.x = -1.2 * lift;
    player.skin.rightArm.rotation.z = 0.45 * lift;
    player.skin.head.rotation.x += 0.2 * lift;
    player.skin.head.rotation.z = -0.15 * lift + Math.sin(t * 3) * 0.05 * lift;
    return t > 2.4;
  },
  jumpSpin(player, t) {
    const phase = Math.min(t / 1.0, 1);
    player.position.y = Math.sin(phase * Math.PI) * 5;
    player.rotation.y = ease(phase) * Math.PI * 2;
    const arms = Math.sin(phase * Math.PI);
    player.skin.leftArm.rotation.z = arms * 1.8;
    player.skin.rightArm.rotation.z = -arms * 1.8;
    return t > 1.15;
  },
  /** The dab: head down into one elbow, the other arm thrown up and out. */
  dab(player, t) {
    const pose = envelope(t, 1.5, 0.18, 0.35);
    player.skin.head.rotation.x += 0.22 * pose;
    player.skin.head.rotation.y += -0.55 * pose;
    player.skin.leftArm.rotation.z = 2.2 * pose;
    player.skin.leftArm.rotation.x = -0.3 * pose;
    player.skin.rightArm.rotation.x = -1.25 * pose;
    player.skin.rightArm.rotation.z = 0.2 * pose;
    player.skin.body.rotation.y = -0.2 * pose;
    return t > 1.5;
  },
  /** Showing the muscles: arms up at the sides, a little bounce. */
  flex(player, t) {
    const pose = envelope(t, 1.8, 0.25, 0.35);
    const pump = Math.sin(t * 9) * 0.12 * pose;
    player.skin.leftArm.rotation.z = (1.45 + pump) * pose;
    player.skin.rightArm.rotation.z = -(1.45 + pump) * pose;
    player.skin.leftArm.rotation.x = -0.35 * pose;
    player.skin.rightArm.rotation.x = -0.35 * pose;
    player.position.y = Math.abs(Math.sin(t * 9)) * 0.3 * pose;
    return t > 1.8;
  },
  /** An air kiss: the hand to the lips (in front of the face), then sent forward. */
  kiss(player, t) {
    const toFace = envelope(t, 0.9, 0.3, 0.25);
    const send = t > 0.7 ? envelope(t - 0.7, 0.9, 0.2, 0.4) : 0;
    player.skin.rightArm.rotation.x = -1.5 * toFace - 1.0 * send;
    player.skin.rightArm.rotation.z = -0.15 * toFace;
    player.skin.head.rotation.x += 0.1 * toFace - 0.12 * send;
    return t > 1.6;
  },
  /** A polite bow: a gentle lean, one hand to the chest, the other behind the back. */
  bow(player, t) {
    const down = envelope(t, 2.0, 0.55, 0.6);
    lean(player, 0.7 * down);
    player.skin.head.rotation.x += 0.25 * down;
    player.skin.rightArm.rotation.x -= 0.45 * down;
    player.skin.rightArm.rotation.z += 0.35 * down;
    player.skin.leftArm.rotation.x += 0.35 * down;
    return t > 2.0;
  },
  /** A confident pose: hands on the hips, the body swaying. */
  pose(player, t) {
    const pose = envelope(t, 2.0, 0.3, 0.4);
    const sway = Math.sin(t * 5) * pose;
    player.skin.leftArm.rotation.z = 0.75 * pose;
    player.skin.rightArm.rotation.z = -0.75 * pose;
    player.skin.leftArm.rotation.x = 0.35 * pose;
    player.skin.rightArm.rotation.x = 0.35 * pose;
    player.rotation.z = sway * 0.06;
    player.rotation.y = 0.35 * pose + sway * 0.1;
    player.skin.head.rotation.z = -sway * 0.1;
    return t > 2.0;
  },
  facepalm(player, t) {
    const hand = envelope(t, 1.7, 0.25, 0.4);
    player.skin.rightArm.rotation.x = -1.55 * hand;
    player.skin.rightArm.rotation.z = 0.1 * hand;
    player.skin.head.rotation.x += 0.22 * hand;
    player.skin.head.rotation.y += Math.sin(t * 6) * 0.12 * hand;
    return t > 1.7;
  },
  /**
   * A little walk: turns to one side, walks a few steps, turns round, walks back and faces you again
   * (the place it walks to stays inside the view).
   */
  stroll(player, t) {
    const LENGTH = 4.6;
    const turn = (from, to, start, length) => from + (to - from) * ease((t - start) / length);
    let yaw;
    let x;
    if (t < 0.45) {
      yaw = turn(0, Math.PI / 2, 0, 0.45);
      x = 0;
    } else if (t < 2.05) {
      yaw = Math.PI / 2;
      x = 5 * ease((t - 0.45) / 1.6);
    } else if (t < 2.6) {
      yaw = turn(Math.PI / 2, -Math.PI / 2, 2.05, 0.55);
      x = 5;
    } else if (t < 4.2) {
      yaw = -Math.PI / 2;
      x = 5 * (1 - ease((t - 2.6) / 1.6));
    } else {
      yaw = turn(-Math.PI / 2, 0, 4.2, 0.4);
      x = 0;
    }
    const walking = (t > 0.45 && t < 2.05) || (t > 2.6 && t < 4.2) ? 1 : 0;
    const step = Math.sin(t * 9) * walking;
    player.rotation.y = yaw;
    player.position.x = x;
    player.position.y = Math.abs(step) * 0.35;
    player.skin.leftLeg.rotation.x = step * 0.55;
    player.skin.rightLeg.rotation.x = -step * 0.55;
    player.skin.leftArm.rotation.x = -step * 0.45;
    player.skin.rightArm.rotation.x = step * 0.45;
    return t > LENGTH;
  },
  /** Victory: one arm punched up and down, a jump. */
  victory(player, t) {
    const pump = Math.abs(Math.sin(Math.min(t / 1.3, 1) * Math.PI * 3));
    const on = envelope(t, 1.5, 0.15, 0.3);
    player.skin.rightArm.rotation.z = -(1.9 + pump * 0.6) * on;
    player.skin.leftArm.rotation.z = 0.25 * on;
    player.position.y = pump * 1.2 * on;
    return t > 1.5;
  },
};

/** The little effect that goes with a gesture (see particles.js), if any. */
export const GESTURE_EFFECTS = { hello: 'sparkles', kiss: 'hearts', dance: 'notes', victory: 'sparkles', flex: 'stars', dab: 'stars', jumpSpin: 'sparkles', clap: 'notes' };

// Crouch and bow are the game's sneak lean: fine on request, odd on a big model on its own — not used here.
// 'point' (at the mouse) is the home player's own: it needs to know where the pointer is.
export const IDLE_GESTURES = ['wave', 'nod', 'dance', 'clap', 'stretch', 'shrug', 'lookAround', 'walk', 'stroll', 'stroll', 'point', 'point', 'salute', 'think', 'jumpSpin', 'dab', 'flex', 'kiss', 'pose', 'facepalm', 'victory'];
export const GREETINGS = ['wave', 'hello', 'kiss', 'flex', 'salute'];
/** What a skin does when it comes to the middle of the Wardrobe. */
export const SHOWCASE = ['hello', 'pose', 'flex', 'dab', 'victory', 'kiss', 'dance', 'jumpSpin'];

const PARTS = ['head', 'body', 'rightArm', 'leftArm', 'rightLeg', 'leftLeg'];

/** Every part back to its place and angle (the places are remembered the first time). */
export function resetPose(player) {
  player.userData.restPositions ??= Object.fromEntries(PARTS.map((part) => [part, player.skin[part].position.clone()]));
  for (const part of PARTS) {
    player.skin[part].rotation.set(0, 0, 0);
    // Height and depth only: the arms' sideways place changes with the model (slim or classic).
    player.skin[part].position.y = player.userData.restPositions[part].y;
    player.skin[part].position.z = player.userData.restPositions[part].z;
  }
  player.position.x = 0;
  player.position.y = 0;
  player.rotation.set(0, 0, 0);
}

/**
 * How high the arms are (0 down … 1 over the head): with arms up the head turns less after the mouse,
 * so a raised arm never goes into a turned head.
 */
export function armsRaised(player) {
  const lift = (arm) => Math.max(Math.min(1, Math.max(0, (Math.abs(arm.rotation.z) - 1.1) / 1.0)), Math.min(1, Math.max(0, (-arm.rotation.x - 1.0) / 0.7)));
  return Math.max(lift(player.skin.leftArm), lift(player.skin.rightArm));
}
