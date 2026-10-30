"""
The launcher's icons as real 3D models, rendered in Blender (Cycles): the same set and colours as the
smooth icons (make-smooth-icons.js), each one built from shapes with thickness and rounded edges, glossy
plastic, metal and glass, lit like a studio and seen straight on.

Usage (Blender 4.2 or newer):
  blender -b --factory-startup -P installer/tools/make-3d-icons.py -- [--size 96] [--out <folder>] [names…]
Writes <folder>/<name>.3d.png (src/assets/ui by default; 96 × 96, transparent), rendered at twice the
size and halved, so the edges are smooth.
"""
import math
import os
import sys
import tempfile

import bmesh
import bpy
from mathutils import Vector

ARGS = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []


def option(name, default):
    if name in ARGS:
        index = ARGS.index(name)
        value = ARGS[index + 1]
        del ARGS[index:index + 2]
        return value
    return default


SIZE = int(option('--size', 96))
OUT = os.path.abspath(option('--out', os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'src', 'assets', 'ui')))
ONLY = set(ARGS)
os.makedirs(OUT, exist_ok=True)

# --- Scene -----------------------------------------------------------------------------------------------
scene = bpy.context.scene
for thing in list(bpy.data.objects):
    bpy.data.objects.remove(thing, do_unlink=True)
scene.render.engine = 'CYCLES'
scene.cycles.samples = 96
scene.cycles.use_denoising = True
scene.render.film_transparent = True
# Glass lets what is under the icon (the button) show through instead of the dark studio.
scene.cycles.film_transparent_glass = True
scene.cycles.film_transparent_roughness = 0.2
scene.render.resolution_x = scene.render.resolution_y = SIZE * 2
scene.render.image_settings.file_format = 'PNG'
scene.render.image_settings.color_mode = 'RGBA'
scene.view_settings.view_transform = 'Standard'

# Studio light for reflections; three soft lights give the shape.
world = bpy.data.worlds.new('studio')
scene.world = world
nodes = world.node_tree.nodes
env = nodes.new('ShaderNodeTexEnvironment')
env.image = bpy.data.images.load(os.path.join(bpy.utils.system_resource('DATAFILES', path='studiolights/world'), 'studio.exr'))
background = nodes.get('Background') or nodes.new('ShaderNodeBackground')
background.inputs['Strength'].default_value = 0.5
world.node_tree.links.new(env.outputs['Color'], background.inputs['Color'])
output = next(node for node in nodes if node.type == 'OUTPUT_WORLD')
world.node_tree.links.new(background.outputs['Background'], output.inputs['Surface'])


def light(name, location, size, energy):
    data = bpy.data.lights.new(name, 'AREA')
    data.size = size
    data.energy = energy
    thing = bpy.data.objects.new(name, data)
    scene.collection.objects.link(thing)
    thing.location = location
    thing.rotation_euler = (Vector((0, 0, 0)) - Vector(location)).to_track_quat('-Z', 'Y').to_euler()


light('key', (-3.2, -4.0, 4.6), 4.5, 720)
light('fill', (4.2, -3.2, 1.4), 4.0, 260)
light('rim', (1.5, 4.0, 3.8), 3.0, 520)

camera = bpy.data.objects.new('camera', bpy.data.cameras.new('camera'))
camera.data.lens = 85
scene.collection.objects.link(camera)
scene.camera = camera
# Straight on: an icon that turns in the interface (the gear, the cross) turns round its own middle
# and looks the same after a full turn; the depth shows in the rounded edges, the light and the shine.
YAW, PITCH = 0.0, 0.0
VIEW = Vector((math.sin(YAW) * math.cos(PITCH), -math.cos(YAW) * math.cos(PITCH), math.sin(PITCH)))

icon_collection = bpy.data.collections.new('icon')
scene.collection.children.link(icon_collection)

# --- Materials --------------------------------------------------------------------------------------------
def linear(hex_colour):
    value = [int(hex_colour.lstrip('#')[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    return tuple(((c + 0.055) / 1.055) ** 2.4 if c > 0.04045 else c / 12.92 for c in value) + (1.0,)


def set_input(node, name, value):
    if name in node.inputs:
        node.inputs[name].default_value = value


_materials = {}


def material(colour, rough=0.3, coat=0.55, metal=0.0, glass=0.0):
    key = (colour, rough, coat, metal, glass)
    if key not in _materials:
        made = bpy.data.materials.new(colour)
        shader = made.node_tree.nodes['Principled BSDF']
        set_input(shader, 'Base Color', linear(colour))
        set_input(shader, 'Roughness', rough)
        set_input(shader, 'Metallic', metal)
        set_input(shader, 'Coat Weight', coat)
        set_input(shader, 'Coat Roughness', 0.05)
        if glass:
            set_input(shader, 'Transmission Weight', glass)
            set_input(shader, 'IOR', 1.45)
        _materials[key] = made
    return _materials[key]


def plastic(colour):
    return material(colour)


def globe_material():
    made = bpy.data.materials.new('globe')
    tree = made.node_tree
    shader = tree.nodes['Principled BSDF']
    set_input(shader, 'Roughness', 0.28)
    set_input(shader, 'Coat Weight', 0.6)
    coords = tree.nodes.new('ShaderNodeTexCoord')
    noise = tree.nodes.new('ShaderNodeTexNoise')
    noise.inputs['Scale'].default_value = 1.6
    noise.inputs['Detail'].default_value = 4.0
    ramp = tree.nodes.new('ShaderNodeValToRGB')
    ramp.color_ramp.interpolation = 'CONSTANT'
    ramp.color_ramp.elements[0].color = linear('#3a8ae0')
    ramp.color_ramp.elements[1].position = 0.56
    ramp.color_ramp.elements[1].color = linear('#5cc867')
    tree.links.new(coords.outputs['Object'], noise.inputs['Vector'])
    tree.links.new(noise.outputs['Fac'], ramp.inputs['Fac'])
    tree.links.new(ramp.outputs['Color'], shader.inputs['Base Color'])
    return made


# --- Shapes ----------------------------------------------------------------------------------------------
# Drawings use the smooth icons' 24 × 24 grid (y down); the model is 2 units wide, facing the camera (−Y).
def to2d(x, y):
    return Vector(((x - 12) / 12, (12 - y) / 12))


def rounded(points, radius, segments=7):
    """A closed polygon (grid units) with round corners, in model units."""
    corners = [to2d(*p) for p in points]
    radius /= 12
    result = []
    for i, b in enumerate(corners):
        a, c = corners[i - 1], corners[(i + 1) % len(corners)]
        u, v = (a - b), (c - b)
        lu, lv = u.length, v.length
        u.normalize()
        v.normalize()
        angle = math.acos(max(-1.0, min(1.0, u.dot(v))))
        if radius <= 0 or angle < 1e-3 or abs(angle - math.pi) < 1e-3:
            result.append(b)
            continue
        cut = min(radius / math.tan(angle / 2), lu * 0.45, lv * 0.45)
        r = cut * math.tan(angle / 2)
        p1, p2 = b + u * cut, b + v * cut
        centre = b + (u + v).normalized() * (r / math.sin(angle / 2))
        a1 = math.atan2(p1.y - centre.y, p1.x - centre.x)
        a2 = math.atan2(p2.y - centre.y, p2.x - centre.x)
        sweep = (a2 - a1 + math.pi) % (2 * math.pi) - math.pi
        result += [centre + Vector((math.cos(a1 + sweep * k / segments), math.sin(a1 + sweep * k / segments))) * r for k in range(segments + 1)]
    return result


def circle(cx, cy, r, count=64):
    return [to2d(cx + r * math.cos(2 * math.pi * k / count), cy + r * math.sin(2 * math.pi * k / count)) for k in range(count)]


def link(thing):
    icon_collection.objects.link(thing)
    return thing


def slab(name, outlines, depth, bevel, mat, front=0.0, pivot=None, tilt=0.0):
    """Flat outlines (one or more; inner ones cut holes) extruded `depth` grid units, edges rounded by
    `bevel`; `front` moves it towards the camera, `tilt` leans its top towards the camera about `pivot`."""
    curve = bpy.data.curves.new(name, 'CURVE')
    curve.dimensions = '2D'
    curve.fill_mode = 'BOTH'
    curve.extrude = max(depth / 2 - bevel, 0.01) / 12
    curve.bevel_depth = bevel / 12
    curve.bevel_resolution = 6
    origin = to2d(*pivot) if pivot else Vector((0, 0))
    for outline in outlines:
        spline = curve.splines.new('POLY')
        spline.points.add(len(outline) - 1)
        for point, co in zip(spline.points, outline):
            point.co = (co.x - origin.x, co.y - origin.y, 0, 1)
        spline.use_cyclic_u = True
        spline.use_smooth = True
    thing = link(bpy.data.objects.new(name, curve))
    thing.data.materials.append(mat)
    thing.location = (origin.x, -front / 12, origin.y)
    thing.rotation_euler = (math.radians(90 + tilt), 0, 0)
    return thing


def mesh(name, build, mat, location=(0, 0, 0), rotation=(0, 0, 0), smooth=True, bevel=0.0, subsurf=0):
    bm = bmesh.new()
    build(bm)
    data = bpy.data.meshes.new(name)
    bm.to_mesh(data)
    bm.free()
    if smooth:
        for polygon in data.polygons:
            polygon.use_smooth = True
    data.materials.append(mat)
    thing = link(bpy.data.objects.new(name, data))
    thing.location = location
    thing.rotation_euler = rotation
    if bevel:
        modifier = thing.modifiers.new('bevel', 'BEVEL')
        modifier.width = bevel
        modifier.segments = 3
        modifier.harden_normals = True
    if subsurf:
        modifier = thing.modifiers.new('round', 'SUBSURF')
        modifier.levels = modifier.render_levels = subsurf
    return thing


def box(name, size, mat, location=(0, 0, 0), rotation=(0, 0, 0), radius=0.06):
    def build(bm):
        bmesh.ops.create_cube(bm, size=1)
        for vert in bm.verts:
            vert.co = Vector((vert.co.x * size[0], vert.co.y * size[1], vert.co.z * size[2]))
    thing = mesh(name, build, mat, location, rotation, smooth=True)
    modifier = thing.modifiers.new('bevel', 'BEVEL')
    modifier.width = radius
    modifier.segments = 2
    modifier = thing.modifiers.new('round', 'SUBSURF')
    modifier.levels = modifier.render_levels = 2
    return thing


def sphere(name, radius, mat, location=(0, 0, 0), scale=(1, 1, 1), cut_below=None):
    def build(bm):
        bmesh.ops.create_uvsphere(bm, u_segments=64, v_segments=32, radius=radius)
        if cut_below is not None:
            bmesh.ops.bisect_plane(bm, geom=bm.verts[:] + bm.edges[:] + bm.faces[:], plane_co=(0, 0, cut_below), plane_no=(0, 0, 1), clear_inner=True)
            bmesh.ops.holes_fill(bm, edges=[edge for edge in bm.edges if edge.is_boundary])
        for vert in bm.verts:
            vert.co = Vector((vert.co.x * scale[0], vert.co.y * scale[1], vert.co.z * scale[2]))
    return mesh(name, build, mat, location)


def cylinder(name, radius, depth, mat, location=(0, 0, 0), rotation=(0, 0, 0), segments=48, radius2=None, bevel=0.02):
    def build(bm):
        bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=segments, radius1=radius, radius2=radius if radius2 is None else radius2, depth=depth)
    return mesh(name, build, mat, location, rotation, bevel=bevel)


def grid(x, y, front=0.0):
    """A point of the drawing as a location in the model."""
    point = to2d(x, y)
    return (point.x, -front / 12, point.y)


# --- Icons -----------------------------------------------------------------------------------------------
def tray(colour):
    box('tray', (18 / 12, 3.6 / 12, 4.2 / 12), plastic(colour), grid(12, 19.1), radius=0.07)


def icon_play():
    slab('play', [rounded([(7, 3.4), (7, 20.6), (21, 12)], 2.2)], 4, 1.1, plastic('#46c95a'))


def icon_user():
    sphere('head', 4.5 / 12, plastic('#ffc08a'), grid(12, 7.6))
    sphere('body', 1, plastic('#4f93f0'), grid(12, 21.4), scale=(8.4 / 12, 4.2 / 12, 8 / 12), cut_below=0)


def icon_download():
    tray('#a984ff')
    slab('arrow', [rounded([(10, 2.6), (14, 2.6), (14, 10.2), (17.6, 10.2), (12, 15.8), (6.4, 10.2), (10, 10.2)], 1.0)], 3.4, 1.0, plastic('#46c95a'), front=0.4)


def icon_export():
    tray('#a984ff')
    slab('arrow', [rounded([(12, 3.4), (17.6, 9), (14, 9), (14, 15.8), (10, 15.8), (10, 9), (6.4, 9)], 1.0)], 3.4, 1.0, plastic('#4f9cf2'), front=0.4)


def icon_folder():
    slab('back', [rounded([(3, 4.4), (9.4, 4.4), (11.4, 6.6), (21, 6.6), (21, 20), (3, 20)], 1.6)], 2.0, 0.6, plastic('#d99a25'), front=-1.4)
    slab('front', [rounded([(2.6, 9), (21.4, 9), (21.4, 20.2), (2.6, 20.2)], 2.0)], 2.0, 0.7, plastic('#ffcf4d'), front=0.8, pivot=(12, 20.2), tilt=14)


def icon_gear():
    outline = []
    for tooth in range(8):
        a = math.radians(tooth * 45)
        for angle, r in ((a - 0.30, 7.2), (a - 0.17, 10.3), (a + 0.17, 10.3), (a + 0.30, 7.2)):
            outline.append((12 + r * math.sin(angle), 12 - r * math.cos(angle)))
    slab('gear', [rounded(outline, 0.9, 4), circle(12, 12, 3.3)], 3.6, 1.0, material('#d8d9e6', rough=0.3, coat=0.6, metal=0.25))


def icon_search():
    ring = bpy.data.meshes.new('ring')
    bm = bmesh.new()
    major, minor = 6.2 / 12, 1.25 / 12
    rings, sides = 64, 20
    verts = [[bm.verts.new(Vector(((major + minor * math.cos(t)) * math.cos(s), (major + minor * math.cos(t)) * math.sin(s), minor * math.sin(t))))
              for t in (2 * math.pi * j / sides for j in range(sides))] for s in (2 * math.pi * i / rings for i in range(rings))]
    for i in range(rings):
        for j in range(sides):
            bm.faces.new((verts[i][j], verts[(i + 1) % rings][j], verts[(i + 1) % rings][(j + 1) % sides], verts[i][(j + 1) % sides]))
    bm.to_mesh(ring)
    bm.free()
    for polygon in ring.polygons:
        polygon.use_smooth = True
    ring.materials.append(material('#6c6c84', rough=0.3, coat=0.4, metal=0.5))
    thing = link(bpy.data.objects.new('ring', ring))
    thing.location = grid(10.5, 10.5)
    thing.rotation_euler = (math.radians(90), 0, 0)
    cylinder('lens', 6.2 / 12, 0.6 / 12, material('#bfe6ff', rough=0.03, coat=0.0, glass=0.8), grid(10.5, 10.5), (math.radians(90), 0, 0), bevel=0.01)
    cylinder('handle', 1.55 / 12, 7 / 12, plastic('#9a6430'), grid(18.3, 18.3), (0, math.radians(-45), 0), bevel=0.03)
    cylinder('collar', 1.8 / 12, 1.2 / 12, material('#9a9ab0', rough=0.25, coat=0.0, metal=1.0), grid(15.3, 15.3), (0, math.radians(-45), 0), bevel=0.015)


def icon_file():
    paper = material('#f6f1e4', rough=0.45, coat=0.15)
    slab('sheet', [rounded([(5, 2.4), (14.2, 2.4), (19, 7.2), (19, 21.8), (5, 21.8)], 1.2)], 1.6, 0.5, paper)
    slab('fold', [rounded([(14.2, 2.4), (19, 7.2), (14.2, 7.2)], 0.6)], 1.0, 0.4, material('#d9cdb0', rough=0.45, coat=0.15), front=1.0)
    for y, end in ((11.6, 15.6), (14.9, 15.6), (18.2, 13)):
        box('line', ((end - 8.4) / 12, 0.7 / 12, 1.5 / 12), plastic('#b3a78c'), grid((8.4 + end) / 2, y, 0.95), radius=0.04)


def icon_cube():
    box('cube', (1.18, 1.18, 1.18), plastic('#9b6bf0'), (0, 0, 0), (math.radians(14), 0, math.radians(38)), radius=0.12)


def icon_stack():
    pivot = bpy.data.objects.new('stack', None)
    link(pivot)
    for index, colour in enumerate(('#e6e6f4', '#a6a6c6', '#6f6f96')):
        layer = box('layer', (1.25, 1.25, 0.2), plastic(colour), (0, 0, 0.36 - index * 0.36), (0, 0, math.radians(45)), radius=0.07)
        layer.parent = pivot
    pivot.rotation_euler = (math.radians(42), 0, 0)


def icon_home():
    box('walls', (14 / 12, 9 / 12, 10 / 12), plastic('#f0c38c'), grid(12, 16), radius=0.04)
    slab('roof', [rounded([(1.8, 12.6), (12, 2.8), (22.2, 12.6)], 1.2)], 11.5, 0.7, plastic('#b5643a'))
    box('door', (4 / 12, 0.8 / 12, 6.4 / 12), plastic('#7a4422'), grid(12, 17.9, 4.6), radius=0.04)
    box('chimney', (2.2 / 12, 2.2 / 12, 4 / 12), plastic('#9a5532'), grid(17, 5.6, -1), radius=0.03)


def icon_bolt():
    slab('bolt', [rounded([(13.8, 2.0), (4.8, 13.6), (11, 13.6), (9.2, 22), (19.2, 9.2), (12.8, 9.2)], 0.8)], 3.6, 1.0, material('#ffc928', rough=0.22, coat=0.7))


def icon_pencil():
    pivot = bpy.data.objects.new('pencil', None)
    link(pivot)
    parts = [
        cylinder('lead', 0.0, 0.14, plastic('#3c3c4c'), (0, 0, -0.9), segments=24, radius2=0.05, bevel=0),
        cylinder('wood', 0.05, 0.34, plastic('#f2d3a5'), (0, 0, -0.66), segments=6, radius2=0.19, bevel=0),
        cylinder('body', 0.19, 1.0, plastic('#ffc83a'), (0, 0, 0.01), segments=6, bevel=0.03),
        cylinder('band', 0.2, 0.14, material('#c4c4d2', rough=0.25, coat=0.0, metal=1.0), (0, 0, 0.58), bevel=0.02),
        cylinder('eraser', 0.19, 0.22, plastic('#ff8ea4'), (0, 0, 0.76), bevel=0.06),
    ]
    for part in parts:
        part.parent = pivot
    pivot.rotation_euler = (0, math.radians(45), 0)


def icon_image():
    box('frame', (19.6 / 12, 1.2 / 12, 17.6 / 12), plastic('#f4f2fa'), grid(12, 12, -0.6), radius=0.06)
    box('sky', (17 / 12, 0.8 / 12, 15 / 12), material('#8fd0ff', rough=0.35, coat=0.3), grid(12, 12, 0.2), radius=0.03)
    slab('hills', [rounded([(3.6, 19.4), (3.6, 16.6), (8.3, 11.2), (13.2, 16), (15.9, 13.6), (20.4, 18), (20.4, 19.4)], 0.9)], 1.2, 0.45, plastic('#4fb85a'), front=1.1)
    sphere('sun', 2.1 / 12, material('#ffe066', rough=0.3, coat=0.5), grid(16.2, 8.6, 1.0))


def icon_cloud():
    data = bpy.data.metaballs.new('cloud')
    data.resolution = data.render_resolution = 0.02
    data.threshold = 0.6
    for x, y, r in ((12.6, 11.4, 6.4), (7.2, 15.0, 4.8), (17.8, 14.6, 4.6), (11.5, 16.4, 4.6), (15.6, 16.6, 4.2)):
        element = data.elements.new()
        element.co = grid(x, y)
        element.radius = r / 12 * 1.25
    data.materials.append(material('#f7f9ff', rough=0.45, coat=0.2))
    thing = link(bpy.data.objects.new('cloud', data))
    thing.scale = (1, 0.62, 1)


def icon_globe():
    globe = sphere('globe', 0.78, globe_material())
    globe.rotation_euler = (math.radians(12), math.radians(-18), math.radians(30))


def icon_close():
    w, length = 1.75, 8.2
    cross = [(-w, length), (w, length), (w, w), (length, w), (length, -w), (w, -w), (w, -length), (-w, -length), (-w, -w), (-length, -w), (-length, w), (-w, w)]
    turned = [(12 + (x - y) * 0.7071, 12 + (x + y) * 0.7071) for x, y in cross]
    slab('close', [rounded(turned, 1.3)], 3.6, 1.0, plastic('#f2392c'))


ICONS = {name[5:]: build for name, build in dict(globals()).items() if name.startswith('icon_') and callable(build)}


def fit_camera():
    depsgraph = bpy.context.evaluated_depsgraph_get()
    points = []
    for thing in icon_collection.objects:
        if thing.type in {'MESH', 'CURVE', 'META'}:
            evaluated = thing.evaluated_get(depsgraph)
            shape = evaluated.to_mesh()
            points += [evaluated.matrix_world @ vert.co for vert in shape.vertices]
            evaluated.to_mesh_clear()
    centre = sum(points, Vector()) / len(points)
    camera.data.lens = 85
    camera.location = centre + VIEW * 10
    camera.rotation_euler = (-VIEW).to_track_quat('-Z', 'Y').to_euler()
    bpy.context.view_layer.update()
    location, _ = camera.camera_fit_coords(depsgraph, [c for p in points for c in p])
    camera.location = location
    # A little room round the model: a wider lens from the same place.
    camera.data.lens = 85 * 0.86


for name, build in ICONS.items():
    if ONLY and name not in ONLY:
        continue
    for thing in list(icon_collection.objects):
        bpy.data.objects.remove(thing, do_unlink=True)
    build()
    fit_camera()
    rendered = os.path.join(tempfile.gettempdir(), f'amethyx-icon-{name}.png')
    scene.render.filepath = rendered
    bpy.ops.render.render(write_still=True)
    picture = bpy.data.images.load(rendered)
    picture.scale(SIZE, SIZE)
    picture.filepath_raw = os.path.join(OUT, f'{name}.3d.png')
    picture.file_format = 'PNG'
    picture.save()
    bpy.data.images.remove(picture)
    os.remove(rendered)
    print('ICON', name)
